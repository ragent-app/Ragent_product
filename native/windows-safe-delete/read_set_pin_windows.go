//go:build windows

package safedelete

import (
	"crypto/sha256"
	"errors"
	"path/filepath"
	"strings"
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
