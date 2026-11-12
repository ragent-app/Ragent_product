//go:build windows

package safedelete

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

var ErrExecutableIdentity = errors.New("executable identity cannot be pinned")

// PinnedExecutable holds an image open without write/delete sharing until
// Close. The digest must come from an independently trusted decision; a hash
// supplied by an untrusted command does not establish trust. This primitive
// does not verify or pin DLLs, child programs, configuration, or directories.
type PinnedExecutable struct {
	file *os.File
	path string
}

func (p *PinnedExecutable) Path() string { return p.path }

func (p *PinnedExecutable) Close() error {
	if p.file == nil {
		return nil
	}
	err := p.file.Close()
	p.file = nil
	return err
}

// OpenPinnedExecutable binds a previously authorized image and digest to the
// file handle used throughout a later execution. No process is started here.
func OpenPinnedExecutable(name string, expected [sha256.Size]byte) (*PinnedExecutable, error) {
	return openPinnedExecutable(name, expected, false)
}

func openPinnedExecutable(name string, expected [sha256.Size]byte, allowHardLinks bool) (*PinnedExecutable, error) {
	return openPinnedImageFile(name, expected, allowHardLinks, false)
}

func openPinnedImageFile(name string, expected [sha256.Size]byte, allowHardLinks, allowDLL bool) (*PinnedExecutable, error) {
	clean := filepath.Clean(name)
	ext := strings.ToLower(filepath.Ext(clean))
	if !filepath.IsAbs(clean) || len(filepath.VolumeName(clean)) != 2 || (ext != ".exe" && (!allowDLL || ext != ".dll")) ||
		strings.Contains(clean[2:], ":") {
		return nil, ErrExecutableIdentity
	}
	return openPinnedRegularFile(clean, expected, allowHardLinks)
}

func openPinnedRegularFile(name string, expected [sha256.Size]byte, allowHardLinks bool) (*PinnedExecutable, error) {
	pin, _, err := openPinnedRegularFileDigest(name, &expected, allowHardLinks)
	return pin, err
}

func openPinnedRegularFileDigest(name string, expected *[sha256.Size]byte, allowHardLinks bool) (*PinnedExecutable, [sha256.Size]byte, error) {
	var digest [sha256.Size]byte
	clean := filepath.Clean(name)
	if !filepath.IsAbs(clean) || len(filepath.VolumeName(clean)) != 2 || strings.Contains(clean[2:], ":") {
		return nil, digest, ErrExecutableIdentity
	}
	ptr, err := windows.UTF16PtrFromString(clean)
	if err != nil {
		return nil, digest, ErrExecutableIdentity
	}
	h, err := windows.CreateFile(ptr, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_SEQUENTIAL_SCAN, 0)
	if err != nil {
		return nil, digest, ErrExecutableIdentity
	}
	file := os.NewFile(uintptr(h), clean)
	if file == nil {
		windows.CloseHandle(h)
		return nil, digest, ErrExecutableIdentity
	}
	ok := false
	defer func() {
		if !ok {
			_ = file.Close()
		}
	}()
	var info windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(h, &info) != nil || info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 || info.NumberOfLinks == 0 || (!allowHardLinks && info.NumberOfLinks != 1) {
		return nil, digest, ErrExecutableIdentity
	}
	buf := make([]uint16, 32768)
	n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0)
	if err != nil || n == 0 || n >= uint32(len(buf)) || !strings.EqualFold(windows.UTF16ToString(buf[:n]), `\\?\`+clean) {
		return nil, digest, ErrExecutableIdentity
	}
	hash := sha256.New()
	if _, err = io.Copy(hash, file); err != nil {
		return nil, digest, ErrExecutableIdentity
	}
	copy(digest[:], hash.Sum(nil))
	if expected != nil && subtle.ConstantTimeCompare(digest[:], expected[:]) != 1 {
		return nil, digest, ErrExecutableIdentity
	}
	ok = true
	return &PinnedExecutable{file: file, path: clean}, digest, nil
}
