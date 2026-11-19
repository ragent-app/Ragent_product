//go:build windows

// Codex history reader runs only as the owner, never as the broker service.
// The broker must authenticate and bind an individual request before invoking it.
package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

var datePart = regexp.MustCompile(`^[0-9]{2,4}$`)
var errHistoryNotFound = errors.New("history not found")
var errHistoryDenied = errors.New("history access denied")
var errHistoryChanged = errors.New("history changed")

func historyIOError(err error) error {
	if errors.Is(err, os.ErrPermission) {
		return errHistoryDenied
	}
	return errors.New("history unavailable")
}

func isReparsePoint(path string) (bool, error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return false, err
	}
	attrs, err := syscall.GetFileAttributes(p)
	return attrs&0x400 != 0, err
}

// Lookup uses the owner profile and its configured CODEX_HOME, never a path
// supplied in the broker request.
func readSession(id string, cursor string) (map[string]any, error) {
	if !historyCursorPattern.MatchString(cursor) {
		return nil, errors.New("invalid cursor")
	}
	parts := strings.Split(cursor, ":")
	offset, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return nil, errors.New("invalid cursor")
	}
	if !uuidPattern.MatchString(id) || offset < 0 {
		return nil, errors.New("invalid request")
	}
	home, err := os.UserHomeDir()
	if err != nil || !filepath.IsAbs(home) {
		return nil, errors.New("owner profile unavailable")
	}
	codexHome := filepath.Join(home, ".codex")
	if custom := os.Getenv("CODEX_HOME"); custom != "" {
		if !filepath.IsAbs(custom) {
			return nil, errors.New("session root unavailable")
		}
		codexHome = filepath.Clean(custom)
	}
	var found string
	count := 0
	for _, folder := range []string{"sessions", "archived_sessions"} {
		root := filepath.Join(codexHome, folder)
		info, e := os.Lstat(root)
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			return nil, historyIOError(e)
		}
		reparse, e := isReparsePoint(root)
		if e != nil {
			return nil, historyIOError(e)
		}
		if !info.IsDir() || reparse {
			return nil, errors.New("session root unavailable")
		}
		err = filepath.WalkDir(root, func(p string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			count++
			if count > 200000 {
				return errors.New("session search limit exceeded")
			}
			if p == root {
				return nil
			}
			rel, e := filepath.Rel(root, p)
			if e != nil {
				return e
			}
			parts := strings.Split(rel, string(filepath.Separator))
			reparse, e := isReparsePoint(p)
			if e != nil {
				return e
			}
			if reparse {
				if (len(parts) <= 3 && datePart.MatchString(d.Name())) || strings.HasSuffix(strings.ToLower(d.Name()), "-"+strings.ToLower(id)+".jsonl") {
					return errors.New("session search unavailable")
				}
				return nil
			}
			if d.IsDir() {
				if len(parts) > 3 || !datePart.MatchString(d.Name()) {
					return filepath.SkipDir
				}
				return nil
			}
			if (folder == "sessions" && len(parts) != 4 || folder == "archived_sessions" && len(parts) != 1) || !strings.HasSuffix(strings.ToLower(d.Name()), "-"+strings.ToLower(id)+".jsonl") {
				return nil
			}
			info, e := d.Info()
			if e != nil {
				return e
			}
			if !info.Mode().IsRegular() {
				return errors.New("invalid session file")
			}
			if found != "" {
				return errors.New("ambiguous session")
			}
			found = p
			return nil
		})
		if err != nil {
			return nil, historyIOError(err)
		}
	}
	if found == "" {
		return nil, errHistoryNotFound
	}
	before, err := os.Lstat(found)
	if err != nil {
		return nil, historyIOError(err)
	}
	if !before.Mode().IsRegular() {
		return nil, historyIOError(err)
	}
	name, err := windows.UTF16PtrFromString(found)
	if err != nil {
		return nil, errors.New("session unavailable")
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, historyIOError(err)
	}
	file := os.NewFile(uintptr(handle), "session")
	defer file.Close()
	info, err := file.Stat()
	var handleInfo windows.ByHandleFileInformation
	if err != nil || info.Size() > 128*1024*1024 || windows.GetFileInformationByHandle(handle, &handleInfo) != nil || handleInfo.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || !os.SameFile(before, info) {
		return nil, errHistoryChanged
	}
	// Resolve the opened handle, not just the enumerated path, after opening.
	// This refuses a directory junction substituted during traversal.
	resolved := make([]uint16, 32768)
	n, err := windows.GetFinalPathNameByHandle(windows.Handle(file.Fd()), &resolved[0], uint32(len(resolved)), 0)
	if err != nil || n == 0 || n >= uint32(len(resolved)) || !strings.EqualFold(windows.UTF16ToString(resolved[:n]), `\\?\`+found) {
		return nil, errHistoryChanged
	}
	// A digest binds every page to the same complete file contents.
	h := sha256.New()
	if hashed, hashErr := io.Copy(h, file); hashErr != nil || hashed != info.Size() {
		return nil, errHistoryChanged
	}
	digest := hex.EncodeToString(h.Sum(nil))
	if len(parts) == 2 && parts[1] != digest {
		return nil, errHistoryChanged
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return nil, errors.New("session unavailable")
	}
	// Verify the embedded session identity before disclosing any bytes.
	line, err := bufio.NewReader(io.LimitReader(file, 1024*1024)).ReadBytes('\n')
	if err != nil {
		return nil, errors.New("invalid session header")
	}
	var header struct {
		Type    string `json:"type"`
		Payload struct {
			ID string `json:"id"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &header) != nil || header.Type != "session_meta" || !strings.EqualFold(header.Payload.ID, id) {
		return nil, errors.New("session identity mismatch")
	}
	if offset > info.Size() {
		return nil, errors.New("offset beyond session")
	}
	if _, err = file.Seek(offset, io.SeekStart); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(file, 32*1024))
	if err != nil {
		return nil, err
	}
	// Writers can keep a live rollout open. Rehash after the page read and
	// refuse any concurrently changed snapshot rather than mixing versions.
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return nil, errors.New("session unavailable")
	}
	verify := sha256.New()
	if hashed, hashErr := io.Copy(verify, file); hashErr != nil || hashed != info.Size() || hex.EncodeToString(verify.Sum(nil)) != digest {
		return nil, errHistoryChanged
	}
	next := offset + int64(len(data))
	return map[string]any{"sessionId": strings.ToLower(id), "offset": offset, "nextOffset": next, "nextCursor": fmt.Sprintf("%d:%s", next, digest), "size": info.Size(), "complete": next == info.Size(), "dataBase64": base64.StdEncoding.EncodeToString(data)}, nil
}

func runCodexHistoryReader(args []string) {
	if len(args) != 2 {
		fmt.Fprintln(os.Stderr, "invalid request")
		os.Exit(2)
	}
	result, err := readSession(args[0], args[1])
	if err != nil {
		code := "OWNER_HISTORY_UNAVAILABLE"
		switch {
		case errors.Is(err, errHistoryNotFound):
			code = "OWNER_HISTORY_NOT_FOUND"
		case errors.Is(err, errHistoryDenied):
			code = "OWNER_HISTORY_ACCESS_DENIED"
		case errors.Is(err, errHistoryChanged):
			code = "OWNER_HISTORY_CHANGED"
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"errorCode": code})
		return
	}
	if json.NewEncoder(os.Stdout).Encode(result) != nil {
		os.Exit(1)
	}
}
