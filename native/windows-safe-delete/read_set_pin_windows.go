//go:build windows

package safedelete

import (
	"crypto/sha256"
	"errors"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

// ReadTarget must be produced by a trusted approval decision. The pinning
// operation verifies content and path identity; it does not authorize reads.
type ReadTarget struct {
	Path   string
	SHA256 [sha256.Size]byte
}

// PinnedReadSet holds all file and directory handles until Close. Failure to
// acquire any target releases every previously acquired handle.
type PinnedReadSet struct{ paths []*PinnedReadPath }

func OpenPinnedReadSet(targets []ReadTarget) (*PinnedReadSet, error) {
	if len(targets) == 0 || len(targets) > 128 {
		return nil, errors.New("invalid pinned read target count")
	}
	set := &PinnedReadSet{}
	seen := make(map[string]struct{}, len(targets))
	for _, target := range targets {
		key := strings.ToLower(filepath.Clean(target.Path))
		if _, exists := seen[key]; exists {
			_ = set.Close()
			return nil, errors.New("duplicate pinned read target")
		}
		seen[key] = struct{}{}
		pin, err := OpenPinnedReadPath(target.Path, target.SHA256)
		if err != nil {
			_ = set.Close()
			return nil, errors.New("pinned read target cannot be verified")
		}
		set.paths = append(set.paths, pin)
	}
	return set, nil
}

func (s *PinnedReadSet) Paths() []string {
	if s == nil {
		return nil
	}
	paths := make([]string, 0, len(s.paths))
	for _, pin := range s.paths {
		paths = append(paths, pin.Path())
	}
	return paths
}

// ChildReadHandles contains inheritable duplicates of all locks. Passing these
// through AdditionalInheritedHandles keeps the same files and directory names
// pinned even if the parent exits while its fixed read-only child is running.
type ChildReadHandles struct{ handles []windows.Handle }

func (s *PinnedReadSet) DuplicateForChild() (*ChildReadHandles, error) {
	if s == nil || len(s.paths) == 0 {
		return nil, errors.New("pinned read set is unavailable")
	}
	lease := &ChildReadHandles{}
	process := windows.CurrentProcess()
	for _, pin := range s.paths {
		if pin == nil || pin.path == nil || pin.path.image == nil || pin.path.image.file == nil {
			_ = lease.Close()
			return nil, errors.New("pinned read handle is unavailable")
		}
		source := append([]windows.Handle(nil), pin.path.dirs...)
		source = append(source, windows.Handle(pin.path.image.file.Fd()))
		for _, handle := range source {
			var duplicate windows.Handle
			if err := windows.DuplicateHandle(process, handle, process, &duplicate, 0, true, windows.DUPLICATE_SAME_ACCESS); err != nil {
				_ = lease.Close()
				return nil, errors.New("cannot duplicate pinned read handle")
			}
			lease.handles = append(lease.handles, duplicate)
		}
	}
	return lease, nil
}

func (c *ChildReadHandles) Handles() []syscall.Handle {
	if c == nil {
		return nil
	}
	result := make([]syscall.Handle, len(c.handles))
	for i, handle := range c.handles {
		result[i] = syscall.Handle(handle)
	}
	return result
}

func (c *ChildReadHandles) Close() error {
	if c == nil {
		return nil
	}
	var result error
	for i := len(c.handles) - 1; i >= 0; i-- {
		if err := windows.CloseHandle(c.handles[i]); err != nil && result == nil {
			result = err
		}
	}
	c.handles = nil
	return result
}

func (s *PinnedReadSet) Close() error {
	if s == nil {
		return nil
	}
	var result error
	for i := len(s.paths) - 1; i >= 0; i-- {
		if err := s.paths[i].Close(); err != nil && result == nil {
			result = err
		}
	}
	s.paths = nil
	return result
}
