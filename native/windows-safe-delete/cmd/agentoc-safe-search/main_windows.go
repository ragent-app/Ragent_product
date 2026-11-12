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
	"unsafe"

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

type listingRequest struct {
	SchemaVersion int      `json:"schemaVersion"`
	Directory     string   `json:"directory"`
	Pattern       string   `json:"pattern"`
	Force         bool     `json:"force"`
	Kind          string   `json:"kind,omitempty"`
	Output        string   `json:"output"`
	Properties    []string `json:"properties,omitempty"`
	FormatTable   bool     `json:"formatTable,omitempty"`
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

// All names come from the pinned local directory enumeration. Wildcard
// matching and formatting operate only on JSON values, never on the paths.
const listingScript = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding $false
$r=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$items=@($r.items | Microsoft.PowerShell.Core\Where-Object {
  ($r.kind -eq 'all' -or ($r.kind -eq 'directory' -and $_.directory) -or ($r.kind -eq 'file' -and -not $_.directory)) -and
    $_.name -like [string]$r.pattern } |
  Microsoft.PowerShell.Utility\Sort-Object @{Expression={$_.directory};Descending=$true}, @{Expression={$_.name};Ascending=$true})
if ($r.output -eq 'name') {
  $items | Microsoft.PowerShell.Core\ForEach-Object { [string]$_.name }
} else {
  $props=if ($r.output -eq 'select-name') { @('Name') } else { [string[]]@($r.properties) }
  if (@($props | Microsoft.PowerShell.Core\Where-Object { $_ -ine 'Name' }).Count -gt 0 -and
      @($items | Microsoft.PowerShell.Core\Where-Object { ([uint32]$_.attributes -band 1024) -ne 0 }).Count -gt 0) {
    throw 'reparse metadata unavailable'
  }
  $rows=@($items | Microsoft.PowerShell.Core\ForEach-Object {
    $a=[uint32]$_.attributes
    $mode=if ($_.directory) {'d'} else {'-'}
    foreach($flag in @(32,1,2,4)) { if (($a -band $flag) -ne 0) { $mode+=@{32='a';1='r';2='h';4='s'}[$flag] } else { $mode+='-' } }
    if (-not $r.modernMode) { $mode+='-' }
    [pscustomobject]@{Name=[string]$_.name;Mode=$mode;Length=$(if ($_.directory) {$null} else {[long]$_.size});
      LastWriteTime=[DateTime]::FromFileTime([long]$_.filetime);Attributes=[IO.FileAttributes]$a;PSIsContainer=[bool]$_.directory}
  })
  if ($r.output -eq 'default' -and $rows.Count -gt 0) {
    ''
    '    Directory: ' + [string]$r.directory
    ''
  }
  if ($r.formatTable) {
    $rows | Microsoft.PowerShell.Utility\Select-Object -Property $props | Microsoft.PowerShell.Utility\Format-Table -AutoSize | Microsoft.PowerShell.Utility\Out-String
  } else {
    $rows | Microsoft.PowerShell.Utility\Select-Object -Property $props | Microsoft.PowerShell.Utility\Out-String
  }
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
	if len(args) == 2 && args[0] == "--check-directory" {
		pin, err := safedelete.OpenPinnedListingDirectory(args[1])
		if err != nil {
			return err
		}
		if err := pin.Close(); err != nil {
			return err
		}
		_, err = fmt.Fprintln(stdout, "ok")
		return err
	}
	if len(args) == 2 && args[0] == "--digest" {
		return runDigest(args[1], stdout)
	}
	if len(args) == 2 && args[0] == "--list" {
		return runListing(args[1], stdout, stderr)
	}
	if len(args) == 2 && args[0] == "--list-json" {
		input, items, err := prepareListing(args[1])
		if err != nil {
			return err
		}
		return json.NewEncoder(stdout).Encode(struct {
			Request listingRequest           `json:"request"`
			Items   []safedelete.ListingName `json:"items"`
		}{input, items})
	}
	if len(args) == 2 && args[0] == "--check-list" {
		if err := runListing(args[1], io.Discard, io.Discard); err != nil {
			return err
		}
		_, err := fmt.Fprintln(stdout, "ok")
		return err
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

// The caller is responsible for authorizing the directory. Enumeration does
// not follow entries and does not prove the identity of their contents.
func prepareListing(encoded string) (listingRequest, []safedelete.ListingName, error) {
	var input listingRequest
	if len(encoded) > 30000 {
		return input, nil, errors.New("invalid listing envelope")
	}
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || base64.RawURLEncoding.EncodeToString(data) != encoded {
		return input, nil, errors.New("invalid listing encoding")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || input.SchemaVersion != 1 ||
		len(input.Directory) > 32767 || len(input.Pattern) == 0 || len(input.Pattern) > 255 ||
		strings.ContainsAny(input.Pattern, "\\/:\x00") || !strings.ContainsAny(input.Pattern, "*?[") ||
		(input.Output != "name" && input.Output != "select-name" && input.Output != "select" && input.Output != "default") {
		return input, nil, errors.New("invalid listing request")
	}
	if input.Kind == "" {
		input.Kind = "all"
	}
	if input.Kind != "all" && input.Kind != "file" && input.Kind != "directory" {
		return input, nil, errors.New("invalid listing kind")
	}
	allowedProperties := map[string]bool{"name": true, "mode": true, "length": true, "lastwritetime": true, "attributes": true, "psiscontainer": true}
	seenProperties := map[string]bool{}
	for _, value := range input.Properties {
		key := strings.ToLower(value)
		if !allowedProperties[key] || seenProperties[key] {
			return input, nil, errors.New("invalid listing properties")
		}
		seenProperties[key] = true
	}
	if ((input.Output == "select" || input.Output == "default") && (len(input.Properties) == 0 || len(input.Properties) > 6)) ||
		((input.Output == "name" || input.Output == "select-name") && (len(input.Properties) != 0 || input.FormatTable)) {
		return input, nil, errors.New("invalid listing output")
	}
	if input.Output == "default" && (!input.FormatTable || strings.Join(input.Properties, ",") != "Mode,LastWriteTime,Length,Name") {
		return input, nil, errors.New("invalid default listing")
	}
	pin, err := safedelete.OpenPinnedListingDirectory(input.Directory)
	if err != nil {
		return input, nil, err
	}
	defer pin.Close()
	items, err := pin.Names(input.Force)
	if err != nil {
		return input, nil, err
	}
	return input, items, nil
}

// runListing is also used for a metadata preflight; actual execution uses
// --list-json and formats data in the provider's own PowerShell version.
func runListing(encoded string, stdout, stderr io.Writer) error {
	input, items, err := prepareListing(encoded)
	if err != nil {
		return err
	}
	data, err := json.Marshal(struct {
		Items       []safedelete.ListingName `json:"items"`
		Directory   string                   `json:"directory"`
		Pattern     string                   `json:"pattern"`
		Kind        string                   `json:"kind"`
		Output      string                   `json:"output"`
		Properties  []string                 `json:"properties"`
		FormatTable bool                     `json:"formatTable"`
		ModernMode  bool                     `json:"modernMode"`
	}{items, input.Directory, input.Pattern, input.Kind, input.Output, input.Properties, input.FormatTable, parentUsesModernPowerShell()})
	if err != nil {
		return errors.New("listing data unavailable")
	}
	system, err := windows.GetSystemDirectory()
	if err != nil {
		return errors.New("system PowerShell unavailable")
	}
	shell := filepath.Join(system, "WindowsPowerShell", "v1.0", "powershell.exe")
	cmd := exec.Command(shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(listingScript))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	cmd.Stdin = bytes.NewReader(data)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	return cmd.Run()
}

// The Windows PowerShell and PowerShell 7 FileSystem formatters use different
// Mode column widths. This affects display only, never authorization or paths.
func parentUsesModernPowerShell() bool {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(snapshot)
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	if windows.Process32First(snapshot, &entry) != nil {
		return false
	}
	var parent uint32
	for {
		if entry.ProcessID == uint32(os.Getpid()) {
			parent = entry.ParentProcessID
			break
		}
		if windows.Process32Next(snapshot, &entry) != nil {
			return false
		}
	}
	entry.Size = uint32(unsafe.Sizeof(entry))
	if windows.Process32First(snapshot, &entry) != nil {
		return false
	}
	for {
		if entry.ProcessID == parent {
			return strings.EqualFold(windows.UTF16ToString(entry.ExeFile[:]), "pwsh.exe")
		}
		if windows.Process32Next(snapshot, &entry) != nil {
			return false
		}
	}
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
