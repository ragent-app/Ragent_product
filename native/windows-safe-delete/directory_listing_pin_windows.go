//go:build windows

package safedelete

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// PinnedListingDirectory binds the names of a local directory and all its
// ancestors, not the membership of the directory. The caller must authorize
// the directory before opening it and must not follow returned entries.
type PinnedListingDirectory struct {
	handles []windows.Handle
}

type ListingName struct {
	Name       string `json:"name"`
	Directory  bool   `json:"directory"`
	Attributes uint32 `json:"attributes"`
	Size       int64  `json:"size"`
	FileTime   int64  `json:"filetime"`
}

func OpenPinnedListingDirectory(name string) (*PinnedListingDirectory, error) {
	clean := filepath.Clean(name)
	if !filepath.IsAbs(clean) || len(filepath.VolumeName(clean)) != 2 || strings.Contains(clean[2:], ":") {
		return nil, errors.New("listing path must be local and absolute")
	}
	root := filepath.VolumeName(clean) + `\`
	remaining := strings.TrimPrefix(clean, root)
	var parts []string
	if remaining != "" {
		parts = strings.Split(remaining, `\`)
	}
	rootPtr, err := windows.UTF16PtrFromString(root)
	if err != nil {
		return nil, errors.New("invalid listing volume")
	}
	switch windows.GetDriveType(rootPtr) {
	case windows.DRIVE_FIXED, windows.DRIVE_REMOVABLE, windows.DRIVE_CDROM, windows.DRIVE_RAMDISK:
	default:
		return nil, errors.New("listing volume is not local")
	}
	volumeBuffer := make([]uint16, 1024)
	if windows.GetVolumeNameForVolumeMountPoint(rootPtr, &volumeBuffer[0], uint32(len(volumeBuffer))) != nil {
		return nil, errors.New("listing volume has no local identity")
	}
	volume := windows.UTF16ToString(volumeBuffer)
	if !strings.HasPrefix(strings.ToLower(volume), `\\?\volume{`) || !strings.HasSuffix(volume, `}\`) {
		return nil, errors.New("listing volume has no local identity")
	}
	// A SUBST drive can point into a subdirectory rather than to the volume
	// root. Require the drive and volume GUID to resolve to the same device;
	// opening the volume GUID without this check could enumerate another path.
	deviceFor := func(device string) (string, error) {
		name, err := windows.UTF16PtrFromString(device)
		if err != nil {
			return "", err
		}
		buffer := make([]uint16, 32768)
		if _, err := windows.QueryDosDevice(name, &buffer[0], uint32(len(buffer))); err != nil {
			return "", err
		}
		return windows.UTF16ToString(buffer), nil
	}
	driveDevice, driveErr := deviceFor(filepath.VolumeName(clean))
	volumeDevice, volumeErr := deviceFor(strings.TrimSuffix(strings.TrimPrefix(volume, `\\?\`), `\`))
	if driveErr != nil || volumeErr != nil || driveDevice == "" || !strings.EqualFold(driveDevice, volumeDevice) {
		return nil, errors.New("listing drive does not identify the local volume root")
	}
	ptr, err := windows.UTF16PtrFromString(volume)
	if err != nil {
		return nil, errors.New("listing volume cannot be pinned")
	}
	rootAccess := uint32(windows.FILE_READ_ATTRIBUTES | windows.FILE_TRAVERSE | windows.SYNCHRONIZE)
	if len(parts) == 0 {
		rootAccess |= windows.FILE_LIST_DIRECTORY
	}
	h, err := windows.CreateFile(ptr, rootAccess,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, errors.New("listing volume cannot be pinned")
	}
	lease := &PinnedListingDirectory{handles: []windows.Handle{h}}
	ok := false
	defer func() {
		if !ok {
			_ = lease.Close()
		}
	}()
	for index, part := range parts {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "\\/:*?[]\x00") ||
			strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || deviceName.MatchString(part) {
			return nil, errors.New("invalid listing component")
		}
		objectName, err := windows.NewNTUnicodeString(part)
		if err != nil {
			return nil, errors.New("invalid listing component")
		}
		parent := lease.handles[len(lease.handles)-1]
		oa := windows.OBJECT_ATTRIBUTES{RootDirectory: parent, ObjectName: objectName, Attributes: windows.OBJ_CASE_INSENSITIVE}
		oa.Length = uint32(unsafe.Sizeof(oa))
		var h windows.Handle
		var iosb windows.IO_STATUS_BLOCK
		access := uint32(windows.FILE_READ_ATTRIBUTES | windows.FILE_TRAVERSE | windows.SYNCHRONIZE)
		if index == len(parts)-1 {
			access |= windows.FILE_LIST_DIRECTORY
		}
		err = windows.NtCreateFile(&h, access,
			&oa, &iosb, nil, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, windows.FILE_OPEN,
			windows.FILE_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT, 0, 0)
		if err != nil {
			return nil, errors.New("listing directory cannot be pinned")
		}
		lease.handles = append(lease.handles, h)
		var info windows.ByHandleFileInformation
		if windows.GetFileInformationByHandle(h, &info) != nil || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
			return nil, errors.New("listing path contains an alias")
		}
	}
	buf := make([]uint16, 32768)
	final := lease.handles[len(lease.handles)-1]
	n, err := windows.GetFinalPathNameByHandle(final, &buf[0], uint32(len(buf)), 1) // VOLUME_NAME_GUID
	expected := volume + strings.Join(parts, `\`)
	if err != nil || n == 0 || n >= uint32(len(buf)) || !strings.EqualFold(windows.UTF16ToString(buf[:n]), expected) {
		return nil, errors.New("listing directory identity changed")
	}
	ok = true
	return lease, nil
}

// Names returns only immediate entries through the pinned directory handle. It never
// opens any returned entry, so even a newly added reparse point is not followed.
// Content, target identities and directory membership are not pinned.
func (p *PinnedListingDirectory) Names(includeHidden bool) ([]ListingName, error) {
	if p == nil || len(p.handles) == 0 {
		return nil, errors.New("listing directory is closed")
	}
	var duplicate windows.Handle
	process := windows.CurrentProcess()
	if err := windows.DuplicateHandle(process, p.handles[len(p.handles)-1], process, &duplicate, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		return nil, errors.New("listing directory cannot be enumerated")
	}
	file := os.NewFile(uintptr(duplicate), "pinned-directory")
	if file == nil {
		windows.CloseHandle(duplicate)
		return nil, errors.New("listing directory cannot be enumerated")
	}
	defer file.Close()
	result := make([]ListingName, 0)
	for {
		entries, err := file.Readdir(128)
		for _, entry := range entries {
			attrs, ok := entry.Sys().(*syscall.Win32FileAttributeData)
			if !ok {
				return nil, errors.New("listing attributes unavailable")
			}
			if includeHidden || attrs.FileAttributes&(windows.FILE_ATTRIBUTE_HIDDEN|windows.FILE_ATTRIBUTE_SYSTEM) == 0 {
				if len(result) >= 10000 {
					return nil, errors.New("listing exceeds entry limit")
				}
				size := uint64(attrs.FileSizeHigh)<<32 | uint64(attrs.FileSizeLow)
				stamp := uint64(attrs.LastWriteTime.HighDateTime)<<32 | uint64(attrs.LastWriteTime.LowDateTime)
				if size > uint64(^uint64(0)>>1) || stamp > uint64(^uint64(0)>>1) {
					return nil, errors.New("listing metadata out of range")
				}
				result = append(result, ListingName{Name: entry.Name(), Directory: attrs.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0,
					Attributes: attrs.FileAttributes, Size: int64(size), FileTime: int64(stamp)})
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, errors.New("listing directory cannot be enumerated")
		}
	}
	return result, nil
}

func (p *PinnedListingDirectory) Close() error {
	if p == nil {
		return nil
	}
	var result error
	for i := len(p.handles) - 1; i >= 0; i-- {
		if err := windows.CloseHandle(p.handles[i]); err != nil && result == nil {
			result = err
		}
	}
	p.handles = nil
	return result
}
