/* Isolated feasibility fixture, not a production launcher or security boundary.
 * The caller creates and owns all fixture paths and runs this program as root.
 * Mount changes are confined to a new private mount namespace. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/mount.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static void fail(const char *what) { perror(what); exit(1); }
static void write_map(pid_t child, const char *name, const char *value) {
  char path[128];
  snprintf(path, sizeof(path), "/proc/%ld/%s", (long)child, name);
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0) fail("open mapping");
  size_t size = strlen(value);
  if (write(fd, value, size) != (ssize_t)size) fail("write mapping");
  if (close(fd)) fail("close mapping");
}
static int valid_id(const char *text) {
  if (!text || !*text) return 0;
  for (const char *p = text; *p; p++) if (*p < '0' || *p > '9') return 0;
  errno = 0;
  unsigned long id = strtoul(text, NULL, 10);
  return !errno && id > 0 && id < 0xfffffffeUL;
}
int main(int argc, char **argv) {
  if (argc < 8 || geteuid() != 0 || argv[1][0] != '/' || argv[2][0] != '/' ||
      !valid_id(argv[3]) || !valid_id(argv[4]) || !valid_id(argv[5]) || !valid_id(argv[6])) return 64;
  if (unshare(CLONE_NEWNS)) fail("unshare mount namespace");
  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL)) fail("make namespace private");
  int ready[2], release[2];
  if (pipe2(ready, O_CLOEXEC) || pipe2(release, O_CLOEXEC)) fail("pipe");
  pid_t child = fork();
  if (child < 0) fail("fork");
  if (!child) {
    close(ready[0]); close(release[1]);
    if (unshare(CLONE_NEWUSER)) _exit(70);
    if (write(ready[1], "x", 1) != 1) _exit(71);
    char value;
    if (read(release[0], &value, 1) != 1) _exit(72);
    _exit(0);
  }
  close(ready[1]); close(release[0]);
  char value;
  if (read(ready[0], &value, 1) != 1) { waitpid(child, NULL, 0); fail("create user namespace"); }
  char mapping[128];
  snprintf(mapping, sizeof(mapping), "%s %s 1\n", argv[3], argv[4]);
  write_map(child, "uid_map", mapping);
  write_map(child, "setgroups", "deny\n");
  snprintf(mapping, sizeof(mapping), "%s %s 1\n", argv[5], argv[6]);
  write_map(child, "gid_map", mapping);
  char ns_path[128];
  snprintf(ns_path, sizeof(ns_path), "/proc/%ld/ns/user", (long)child);
  int nsfd = open(ns_path, O_RDONLY | O_CLOEXEC);
  if (nsfd < 0) fail("open user namespace");
  int tree = (int)syscall(SYS_open_tree, AT_FDCWD, argv[1], OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC);
  if (tree < 0) fail("open_tree");
  struct mount_attr attr = { .attr_set = MOUNT_ATTR_IDMAP, .userns_fd = (unsigned long long)nsfd };
  if (syscall(SYS_mount_setattr, tree, "", AT_EMPTY_PATH, &attr, sizeof(attr))) fail("mount_setattr idmap");
  if (syscall(SYS_move_mount, tree, "", AT_FDCWD, argv[2], MOVE_MOUNT_F_EMPTY_PATH)) fail("move_mount");
  close(tree); close(nsfd);
  if (write(release[1], "x", 1) != 1) fail("release namespace child");
  close(release[1]); close(ready[0]);
  if (waitpid(child, NULL, 0) != child) fail("wait namespace child");
  execvp(argv[7], &argv[7]);
  fail("exec fixture");
  return 1;
}
