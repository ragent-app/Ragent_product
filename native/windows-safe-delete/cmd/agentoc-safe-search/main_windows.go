//go:build windows

// This non-elevated executor is not an approval authority. The caller must
// independently authorize each target and supply trusted file digests.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unicode/utf16"

	safedelete "agentoc/windows-safe-delete"
	"golang.org/x/sys/windows"
)

type target struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

type request struct {
	SchemaVersion int      `json:"schemaVersion"`
	Targets       []target `json:"targets"`
	Pattern       string   `json:"pattern"`
	Encoding      string   `json:"encoding,omitempty"`
	Switches      []string `json:"switches,omitempty"`
}

type digestRequest struct {
	SchemaVersion int      `json:"schemaVersion"`
	Paths         []string `json:"paths"`
}

var allowedSwitches = map[string]bool{
	"simplematch": true, "casesensitive": true, "quiet": true, "notmatch": true,
	"allmatches": true, "list": true, "raw": true, "noemphasis": true,
}

// The provider's pattern, paths and flags are only JSON data on stdin. The
// PowerShell source is fixed and uses the built-in module-qualified cmdlet.
const searchScript = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding $false
$r=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$p=@{LiteralPath=[string[]]@($r.paths);Pattern=[string]$r.pattern}
if ($r.encoding) {
  $encoding=[string]$r.encoding
  if ($encoding -iin @('utf8nobom','utf8bom')) {$encoding='utf8'}
  $p.Encoding=$encoding
}
foreach($s in @($r.switches)) {if ($s -and $s -notin @('raw','noemphasis')) {$p[[string]$s]=$true}}
if (@($r.switches) -contains 'raw') {
  Microsoft.PowerShell.Utility\Select-String @p | Microsoft.PowerShell.Core\ForEach-Object {$_.Line}
} else {
  Microsoft.PowerShell.Utility\Select-String @p
}
`

func decodeRequest(args []string) (request, error) {
	var input request
	if len(args) != 2 || args[0] != "--request" || len(args[1]) > 256*1024 {
		return input, errors.New("invalid request envelope")
	}
	data, err := base64.RawURLEncoding.DecodeString(args[1])
	if err != nil || base64.RawURLEncoding.EncodeToString(data) != args[1] {
		return input, errors.New("invalid request encoding")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || input.SchemaVersion != 1 ||
		len(input.Targets) == 0 || len(input.Targets) > 128 || len(input.Pattern) > 32768 || len(input.Encoding) > 64 ||
		strings.ContainsRune(input.Pattern, 0) || strings.ContainsRune(input.Encoding, 0) {
		return request{}, errors.New("invalid request fields")
	}
	seen := map[string]bool{}
	for _, value := range input.Switches {
		if !allowedSwitches[value] || seen[value] {
			return request{}, errors.New("invalid search switch")
		}
		seen[value] = true
	}
	if seen["raw"] && seen["quiet"] {
		return request{}, errors.New("incompatible search switches")
	}
	return input, nil
}

func targetsFor(input request) ([]safedelete.ReadTarget, error) {
	result := make([]safedelete.ReadTarget, 0, len(input.Targets))
	for _, item := range input.Targets {
		digest, err := hex.DecodeString(item.SHA256)
		if err != nil || len(digest) != sha256.Size || item.SHA256 != strings.ToLower(item.SHA256) || len(item.Path) > 32767 {
			return nil, errors.New("invalid target identity")
		}
		var value [sha256.Size]byte
		copy(value[:], digest)
		result = append(result, safedelete.ReadTarget{Path: item.Path, SHA256: value})
	}
	return result, nil
}

func encodedPowerShell(source string) string {
	words := utf16.Encode([]rune(source))
	data := make([]byte, len(words)*2)
	for i, word := range words {
		binary.LittleEndian.PutUint16(data[i*2:], word)
	}
	return base64.StdEncoding.EncodeToString(data)
}

func runSearch(input request, paths []string, handles *safedelete.ChildReadHandles, stdout, stderr io.Writer) error {
	system, err := windows.GetSystemDirectory()
	if err != nil {
		return errors.New("system PowerShell unavailable")
	}
	shell := filepath.Join(system, "WindowsPowerShell", "v1.0", "powershell.exe")
	data, err := json.Marshal(struct {
		Paths    []string `json:"paths"`
		Pattern  string   `json:"pattern"`
		Encoding string   `json:"encoding"`
		Switches []string `json:"switches"`
	}{paths, input.Pattern, input.Encoding, input.Switches})
	if err != nil {
		return errors.New("search input unavailable")
	}
	cmd := exec.Command(shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(searchScript))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW, AdditionalInheritedHandles: handles.Handles()}
	cmd.Stdin = bytes.NewReader(data)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	return cmd.Run()
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 2 && args[0] == "--digest" {
		return runDigest(args[1], stdout)
	}
	input, err := decodeRequest(args)
	if err != nil {
		return err
	}
	targets, err := targetsFor(input)
	if err != nil {
		return err
	}
	set, err := safedelete.OpenPinnedReadSet(targets)
	if err != nil {
		return err
	}
	defer set.Close()
	handles, err := set.DuplicateForChild()
	if err != nil {
		return err
	}
	defer handles.Close()
	return runSearch(input, set.Paths(), handles, stdout, stderr)
}

// This operation establishes identity only. Its caller must authorize each
// requested path before invoking it; digest output is not an approval.
func runDigest(encoded string, stdout io.Writer) error {
	if len(encoded) > 256*1024 {
		return errors.New("invalid digest envelope")
	}
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || base64.RawURLEncoding.EncodeToString(data) != encoded {
		return errors.New("invalid digest encoding")
	}
	var input digestRequest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || input.SchemaVersion != 1 || len(input.Paths) == 0 || len(input.Paths) > 128 {
		return errors.New("invalid digest request")
	}
	targets := make([]target, 0, len(input.Paths))
	seen := make(map[string]bool, len(input.Paths))
	for _, name := range input.Paths {
		key := strings.ToLower(filepath.Clean(name))
		if len(name) > 32767 || seen[key] {
			return errors.New("invalid digest target")
		}
		seen[key] = true
		digest, err := safedelete.DigestPinnedReadPath(name)
		if err != nil {
			return errors.New("digest target cannot be verified")
		}
		targets = append(targets, target{Path: name, SHA256: hex.EncodeToString(digest[:])})
	}
	return json.NewEncoder(stdout).Encode(targets)
}

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "bound search failed")
		os.Exit(1)
	}
}
