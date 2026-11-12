//go:build windows

package safedelete

import (
	"crypto/sha256"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// PinnedExecutablePath holds the image and each directory name in its path.
// It binds path identity, not publisher trust or the executable's dependencies.
// The caller must independently verify those facts before authorizing a run.
type PinnedExecutablePath struct {
	image *PinnedExecutable
	dirs  []windows.Handle
}

func (p *PinnedExecutablePath) Path() string {
	if p == nil || p.image == nil {
		return ""
	}
	return p.image.Path()
}

func (p *PinnedExecutablePath) Close() error {
	var result error
	if p.image != nil {
		result = p.image.Close()
		p.image = nil
	}
	for i := len(p.dirs) - 1; i >= 0; i-- {
		if err := windows.CloseHandle(p.dirs[i]); err != nil && result == nil {
			result = err
		}
	}
	p.dirs = nil
	return result
}

// OpenPinnedExecutablePath protects directory names against rename/deletion
// while allowing ordinary directory reads and writes. It must not be used as
// proof that children cannot be added or replaced, or that DLLs are trusted.
func OpenPinnedExecutablePath(name string, expected [sha256.Size]byte) (*PinnedExecutablePath, error) {
	return openPinnedImagePath(name, expected, false)
}

// OpenPinnedDependencyPath also admits DLLs. A trusted, complete dependency
// manifest and directory mutation protection remain the caller's obligation.
func OpenPinnedDependencyPath(name string, expected [sha256.Size]byte) (*PinnedExecutablePath, error) {
	return openPinnedImagePath(name, expected, true)
}

func openPinnedImagePath(name string, expected [sha256.Size]byte, allowDLL bool) (*PinnedExecutablePath, error) {
	return openPinnedPath(name, expected, allowDLL, false)
}

// PinnedReadPath keeps one previously authorized regular file and its
// directory names stable while the caller performs a read. It does not decide
// whether a path is sensitive; the caller must independently apply policy and
// supply a digest from a trusted approval decision.
type PinnedReadPath struct{ path *PinnedExecutablePath }

func (p *PinnedReadPath) Path() string {
	if p == nil || p.path == nil {
		return ""
	}
	return p.path.Path()
}

func (p *PinnedReadPath) Close() error {
	if p == nil || p.path == nil {
		return nil
	}
	err := p.path.Close()
	p.path = nil
	return err
}

// OpenPinnedReadPath accepts ordinary local paths inside or outside the
// workspace. Reparse points, hard links, content changes and ancestor renames
// are rejected or held blocked by handles until Close.
func OpenPinnedReadPath(name string, expected [sha256.Size]byte) (*PinnedReadPath, error) {
	value, err := openPinnedPath(name, expected, false, true)
	if err != nil {
		return nil, err
	}
	return &PinnedReadPath{path: value}, nil
}

func openPinnedPath(name string, expected [sha256.Size]byte, allowDLL, regularRead bool) (*PinnedExecutablePath, error) {
	clean := filepath.Clean(name)
	ext := strings.ToLower(filepath.Ext(clean))
	if !filepath.IsAbs(clean) || len(filepath.VolumeName(clean)) != 2 || (!regularRead && ext != ".exe" && (!allowDLL || ext != ".dll")) || strings.Contains(clean[2:], ":") {
		return nil, ErrExecutableIdentity
	}
	var chain []string
	for dir := filepath.Dir(clean); ; dir = filepath.Dir(dir) {
		chain = append(chain, dir)
		if filepath.Dir(dir) == dir {
			break
		}
	}
	lease := &PinnedExecutablePath{}
	ok := false
	defer func() {
		if !ok {
			_ = lease.Close()
		}
	}()
	for i := len(chain) - 1; i >= 0; i-- {
		dir := chain[i]
		ptr, err := windows.UTF16PtrFromString(dir)
		if err != nil {
			return nil, ErrExecutableIdentity
		}
		h, err := windows.CreateFile(ptr, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
			nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			return nil, ErrExecutableIdentity
		}
		lease.dirs = append(lease.dirs, h)
		var info windows.ByHandleFileInformation
		if windows.GetFileInformationByHandle(h, &info) != nil || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
			return nil, ErrExecutableIdentity
		}
		buf := make([]uint16, 32768)
		n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0)
		if err != nil || n == 0 || n >= uint32(len(buf)) || !strings.EqualFold(windows.UTF16ToString(buf[:n]), `\\?\`+dir) {
			return nil, ErrExecutableIdentity
		}
	}
	var image *PinnedExecutable
	var err error
	if regularRead {
		image, err = openPinnedRegularFile(clean, expected, false)
	} else {
		image, err = openPinnedImageFile(clean, expected, true, allowDLL)
	}
	if err != nil {
		return nil, err
	}
	lease.image = image
	ok = true
	return lease, nil
}
