/* Read-only building block for a future Linux privileged file adapter.
 * Not an authorization mechanism and not connected to production execution.
 * Trust model: root and other root-equivalent processes are trusted. Every
 * traversed directory and the file must be root-owned, non-writable by other
 * users, and without named or default POSIX ACLs; all must remain on the
 * root filesystem and mount.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <endian.h>
#include <fcntl.h>
#include <linux/posix_acl.h>
#include <linux/posix_acl_xattr.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/xattr.h>
#include <unistd.h>

static int fail(const char *code) {
  fprintf(stderr, "%s\n", code);
  return 1;
}

static int no_acl(int fd) {
  errno = 0;
  if (fgetxattr(fd, "system.posix_acl_default", NULL, 0) >= 0 || errno != ENODATA) return 0;
  unsigned char buffer[sizeof(struct posix_acl_xattr_header) + 4 * sizeof(struct posix_acl_xattr_entry)];
  errno = 0;
  ssize_t size = fgetxattr(fd, "system.posix_acl_access", buffer, sizeof(buffer));
  if (size < 0) return errno == ENODATA;
  if (size < (ssize_t)sizeof(struct posix_acl_xattr_header) ||
      (size - (ssize_t)sizeof(struct posix_acl_xattr_header)) % (ssize_t)sizeof(struct posix_acl_xattr_entry)) return 0;
  struct posix_acl_xattr_header header;
  memcpy(&header, buffer, sizeof(header));
  if (le32toh(header.a_version) != POSIX_ACL_XATTR_VERSION) return 0;
  unsigned int seen = 0;
  for (size_t pos = sizeof(header); pos < (size_t)size; pos += sizeof(struct posix_acl_xattr_entry)) {
    struct posix_acl_xattr_entry entry;
    memcpy(&entry, buffer + pos, sizeof(entry));
    unsigned int tag = le16toh(entry.e_tag), perm = le16toh(entry.e_perm);
    if (!(tag == ACL_USER_OBJ || tag == ACL_GROUP_OBJ || tag == ACL_MASK || tag == ACL_OTHER) ||
        (seen & tag) || perm > 7 || le32toh(entry.e_id) != (unsigned int)ACL_UNDEFINED_ID ||
        ((tag == ACL_GROUP_OBJ || tag == ACL_OTHER) && (perm & ACL_WRITE))) return 0;
    seen |= tag;
  }
  return (seen & (ACL_USER_OBJ | ACL_GROUP_OBJ | ACL_OTHER)) == (ACL_USER_OBJ | ACL_GROUP_OBJ | ACL_OTHER);
}

static int mount_id(int fd, unsigned long long *id) {
  struct statx info;
  if (statx(fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW, STATX_MNT_ID, &info) ||
      !(info.stx_mask & STATX_MNT_ID)) return 0;
  *id = info.stx_mnt_id;
  return 1;
}

static int safe_directory(int fd, dev_t device, unsigned long long root_mount, struct stat *st) {
  unsigned long long mount;
  if (fstat(fd, st) || !S_ISDIR(st->st_mode) || st->st_uid != 0 ||
      (st->st_mode & 0022) || st->st_dev != device || !no_acl(fd) ||
      !mount_id(fd, &mount) || mount != root_mount) return 0;
  return 1;
}

static int same_file(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
    a->st_mode == b->st_mode && a->st_uid == b->st_uid &&
    a->st_gid == b->st_gid && a->st_nlink == b->st_nlink &&
    a->st_size == b->st_size && a->st_ctim.tv_sec == b->st_ctim.tv_sec &&
    a->st_ctim.tv_nsec == b->st_ctim.tv_nsec &&
    a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec;
}

int main(int argc, char **argv) {
  if (geteuid() != 0) return fail("ROOT_REQUIRED");
  if (argc != 2 || !argv[1] || argv[1][0] != '/' || !argv[1][1] ||
      strlen(argv[1]) >= PATH_MAX || strstr(argv[1], "//") ||
      argv[1][strlen(argv[1]) - 1] == '/') return fail("INVALID_PATH");
  char *path = strdup(argv[1] + 1);
  if (!path) return fail("INTERNAL_ERROR");
  int parent = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (parent < 0) { free(path); return fail("ROOT_UNAVAILABLE"); }
  struct stat root, dir;
  unsigned long long root_mount;
  if (fstat(parent, &root) || !mount_id(parent, &root_mount) ||
      !safe_directory(parent, root.st_dev, root_mount, &dir)) {
    close(parent); free(path); return fail("UNTRUSTED_DIRECTORY");
  }
  char *cursor = path;
  char *slash;
  while ((slash = strchr(cursor, '/')) != NULL) {
    *slash = '\0';
    if (!*cursor || !strcmp(cursor, ".") || !strcmp(cursor, "..")) {
      close(parent); free(path); return fail("INVALID_PATH");
    }
    int next = openat(parent, cursor, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (next < 0 || !safe_directory(next, root.st_dev, root_mount, &dir)) {
      if (next >= 0) close(next);
      close(parent); free(path); return fail("UNTRUSTED_DIRECTORY");
    }
    close(parent);
    parent = next;
    cursor = slash + 1;
  }
  if (!*cursor || !strcmp(cursor, ".") || !strcmp(cursor, "..")) {
    close(parent); free(path); return fail("INVALID_PATH");
  }
  struct stat before, opened, after, parent_after;
  if (fstatat(parent, cursor, &before, AT_SYMLINK_NOFOLLOW) ||
      !S_ISREG(before.st_mode) || before.st_uid != 0 || before.st_nlink != 1 ||
      (before.st_mode & 0022) || before.st_dev != root.st_dev) {
    close(parent); free(path); return fail("UNTRUSTED_TARGET");
  }
  int target = openat(parent, cursor, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
  unsigned long long target_mount;
  if (target < 0 || fstat(target, &opened) || !same_file(&before, &opened) ||
      !no_acl(target) || !mount_id(target, &target_mount) || target_mount != root_mount ||
      fstatat(parent, cursor, &after, AT_SYMLINK_NOFOLLOW) ||
      !same_file(&opened, &after) || !safe_directory(parent, root.st_dev, root_mount, &parent_after) ||
      parent_after.st_dev != dir.st_dev || parent_after.st_ino != dir.st_ino) {
    if (target >= 0) close(target);
    close(parent); free(path); return fail("TARGET_CHANGED_OR_UNTRUSTED");
  }
  printf("{\"version\":1,\"mountId\":%llu,\"parentDevice\":%llu,\"parentInode\":%llu,"
         "\"device\":%llu,\"inode\":%llu,\"size\":%lld,"
         "\"ctimeSeconds\":%lld,\"ctimeNanoseconds\":%ld,"
         "\"mtimeSeconds\":%lld,\"mtimeNanoseconds\":%ld}\n",
         root_mount, (unsigned long long)parent_after.st_dev, (unsigned long long)parent_after.st_ino,
         (unsigned long long)after.st_dev, (unsigned long long)after.st_ino,
         (long long)after.st_size, (long long)after.st_ctim.tv_sec, after.st_ctim.tv_nsec,
         (long long)after.st_mtim.tv_sec, after.st_mtim.tv_nsec);
  close(target);
  close(parent);
  free(path);
  return 0;
}
