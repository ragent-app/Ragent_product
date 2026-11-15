//go:build windows

// Package safedelete contains experimental, non-elevated file-handle
// primitives. It is not yet connected to the approval or execution path.
package safedelete

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var protectedName = regexp.MustCompile(`(?i)^(?:\.git|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.ragent|\.env(?:\..*)?|ntuser\.dat(?:\.log\d*)?|system volume information|\$recycle\.bin)$`)
var protectedProfilePath = regexp.MustCompile(`(?i)(?:^|\\)appdata\\(?:local|roaming)\\microsoft\\(?:credentials|protect)(?:\\|$)`)
var deviceName = regexp.MustCompile(`(?i)^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$`)

type Pinned struct {
	handle     windows.Handle
	path       string
	directory  bool
	deletable  bool
	attributes uint32
}

// OpenWorkspace pins an already authorized, local workspace root. The caller
// must independently validate the root against protected system paths.
func OpenWorkspace(root string) (*Pinned, error) {
	clean := filepath.Clean(root)
	if !filepath.IsAbs(clean) || len(clean) < 4 || clean[1:3] != `:\` || strings.HasPrefix(clean, `\\`) || filepath.VolumeName(clean)+`\` == clean {
		return nil, errors.New("workspace must be a non-root local absolute path")
	}
	name, err := windows.UTF16PtrFromString(clean)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(name, windows.FILE_LIST_DIRECTORY|windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	p := &Pinned{handle: h, path: clean}
	if err = p.check(); err != nil {
		p.Close()
		return nil, err
	}
	if !p.directory {
		p.Close()
		return nil, errors.New("workspace is not a directory")
	}
	buffer := make([]uint16, 32768)
	n, err := windows.GetFinalPathNameByHandle(h, &buffer[0], uint32(len(buffer)), 0)
	if err != nil || n == 0 || int(n) >= len(buffer) {
		p.Close()
		return nil, errors.New("cannot verify workspace path")
	}
	actual := strings.TrimPrefix(windows.UTF16ToString(buffer[:n]), `\\?\`)
	if !strings.EqualFold(filepath.Clean(actual), clean) {
		p.Close()
		return nil, errors.New("workspace path resolves through an alias")
	}
	return p, nil
}

func (p *Pinned) check() error {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(p.handle, &info); err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("reparse points are not eligible")
	}
	p.directory = info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0
	p.attributes = info.FileAttributes
	return nil
}

// OpenChild opens exactly one literal child relative to a pinned directory.
// Excluding FILE_SHARE_DELETE prevents a concurrent rename or replacement
// while the returned handle remains open.
func (p *Pinned) OpenChild(name string) (*Pinned, error) {
	return p.openChild(name, true)
}

// Ancestors that will not be removed do not need DELETE access. In
// particular, another process may hold its current-directory handle open.
func (p *Pinned) openChild(name string, deletable bool) (*Pinned, error) {
	if p == nil || p.handle == 0 || !p.directory {
		return nil, errors.New("parent directory is not pinned")
	}
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "\\/\x00:*?[]") || strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") || protectedName.MatchString(name) || deviceName.MatchString(name) {
		return nil, errors.New("child name is not eligible")
	}
	childPath := filepath.Join(p.path, name)
	if protectedProfilePath.MatchString(childPath) {
		return nil, errors.New("child path is protected")
	}
	objectName, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return nil, err
	}
	oa := windows.OBJECT_ATTRIBUTES{RootDirectory: p.handle, ObjectName: objectName, Attributes: windows.OBJ_CASE_INSENSITIVE}
	oa.Length = uint32(unsafe.Sizeof(oa))
	var child windows.Handle
	var iosb windows.IO_STATUS_BLOCK
	access := uint32(windows.FILE_READ_ATTRIBUTES | windows.FILE_LIST_DIRECTORY | windows.SYNCHRONIZE)
	if deletable {
		access |= windows.DELETE
	}
	err = windows.NtCreateFile(&child, access,
		&oa, &iosb, nil, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, windows.FILE_OPEN,
		windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT, 0, 0)
	if err != nil {
		return nil, fmt.Errorf("open pinned child: %w", err)
	}
	result := &Pinned{handle: child, path: childPath, deletable: deletable}
	if err = result.check(); err != nil {
		result.Close()
		return nil, err
	}
	return result, nil
}

func (p *Pinned) duplicateFile() (*os.File, error) {
	if p == nil || p.handle == 0 {
		return nil, errors.New("handle is not pinned")
	}
	var duplicate windows.Handle
	process := windows.CurrentProcess()
	if err := windows.DuplicateHandle(process, p.handle, process, &duplicate, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(duplicate), "pinned")
	if file == nil {
		windows.CloseHandle(duplicate)
		return nil, errors.New("cannot wrap pinned handle")
	}
	return file, nil
}

// snapshotChildren requires enumeration-provided file IDs. Go can otherwise
// fall back to looking up IDs by path later, which would reintroduce a race.
func (p *Pinned) snapshotChildren() ([]os.FileInfo, error) {
	if p == nil || p.handle == 0 || !p.directory {
		return nil, errors.New("directory is not pinned")
	}
	var flags uint32
	if err := windows.GetVolumeInformationByHandle(p.handle, nil, 0, nil, nil, &flags, nil, 0); err != nil {
		return nil, err
	}
	if flags&windows.FILE_SUPPORTS_OBJECT_IDS == 0 || flags&windows.FILE_SUPPORTS_OPEN_BY_FILE_ID == 0 {
		return nil, errors.New("filesystem does not provide stable directory entry IDs")
	}
	file, err := p.duplicateFile()
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var entries []os.FileInfo
	for {
		batch, readErr := file.Readdir(128)
		entries = append(entries, batch...)
		if len(entries) > 1024 {
			return nil, errors.New("directory exceeds entry limit")
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return nil, readErr
		}
	}
	return entries, nil
}

// openListedChild checks that the object opened relative to the pinned parent
// is exactly the object returned by the directory enumeration.
func (p *Pinned) openListedChild(info os.FileInfo) (*Pinned, error) {
	if info == nil {
		return nil, errors.New("directory entry is missing")
	}
	child, err := p.OpenChild(info.Name())
	if err != nil {
		return nil, err
	}
	file, err := child.duplicateFile()
	if err != nil {
		child.Close()
		return nil, err
	}
	actual, err := file.Stat()
	file.Close()
	if err != nil || !os.SameFile(info, actual) {
		child.Close()
		return nil, errors.New("directory entry changed before it was pinned")
	}
	return child, nil
}

func (p *Pinned) Close() error {
	if p == nil || p.handle == 0 {
		return nil
	}
	h := p.handle
	p.handle = 0
	return windows.CloseHandle(h)
}

// DeletePinned removes the object represented by this handle, not a path
// reopened after inspection. A non-empty directory fails rather than removing
// a child that appeared after enumeration. This primitive has no authority
// checks and must not be exposed directly to an agent.
func (p *Pinned) DeletePinned() error {
	return p.deletePinned(false)
}

func (p *Pinned) deletePinned(force bool) error {
	if p == nil || p.handle == 0 || !p.deletable {
		return errors.New("target handle is not pinned")
	}
	if force {
		flags := uint32(windows.FILE_DISPOSITION_DELETE | windows.FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE)
		if err := windows.SetFileInformationByHandle(p.handle, windows.FileDispositionInfoEx, (*byte)(unsafe.Pointer(&flags)), uint32(unsafe.Sizeof(flags))); err != nil {
			return err
		}
	} else {
		mark := byte(1)
		if err := windows.SetFileInformationByHandle(p.handle, windows.FileDispositionInfo, &mark, 1); err != nil {
			return err
		}
	}
	return p.Close()
}
