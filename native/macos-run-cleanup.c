/*
 * Same-user cancellation aid for a shared Codex app-server on macOS.
 *
 * This utility is not a security boundary. It only signals descendants of a supplied app-server
 * process that carry the exact run tag, plus their descendants. Callers must
 * establish the root's identity and the association between the tag and the
 * cancelled turn before invoking it. A process can remove its environment or
 * reparent, so a successful scan is not proof that every descendant stopped.
 */
#include <sys/types.h>
#include <sys/sysctl.h>
#include <libproc.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_PROCARGS (1024 * 1024)
#define MAX_PROCESSES 65536

struct process_info {
  pid_t pid;
  pid_t ppid;
  uid_t uid;
  uint64_t start_sec;
  uint64_t start_usec;
  int marked;
};

static int info(pid_t pid, struct process_info *out) {
  struct proc_bsdinfo p;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &p, sizeof(p)) != sizeof(p)) return 0;
  out->pid = pid;
  out->ppid = (pid_t)p.pbi_ppid;
  out->uid = (uid_t)p.pbi_uid;
  out->start_sec = p.pbi_start_tvsec;
  out->start_usec = p.pbi_start_tvusec;
  out->marked = 0;
  return 1;
}

static int same_process(const struct process_info *expected) {
  struct process_info current;
  return info(expected->pid, &current) && current.uid == expected->uid &&
    current.start_sec == expected->start_sec &&
    current.start_usec == expected->start_usec;
}

/* KERN_PROCARGS2 separates argv and environment with NUL bytes; do not use
 * a formatted ps command line where an argument can impersonate an env var. */
static int has_run_tag(pid_t pid, const char *tag) {
  int mib[] = { CTL_KERN, KERN_PROCARGS2, pid };
  size_t size = 0;
  if (sysctl(mib, 3, NULL, &size, NULL, 0) != 0 || size < sizeof(int) || size > MAX_PROCARGS) return -1;
  char *data = malloc(size);
  if (!data) return -1;
  if (sysctl(mib, 3, data, &size, NULL, 0) != 0 || size < sizeof(int)) { free(data); return -1; }
  int argc;
  memcpy(&argc, data, sizeof(argc));
  if (argc < 0 || argc > 65536) { free(data); return -1; }
  char *p = data + sizeof(argc), *end = data + size;
  while (p < end && *p) p++;
  while (p < end && !*p) p++;
  for (int i = 0; i < argc; i++) {
    while (p < end && *p) p++;
    if (p == end) { free(data); return -1; }
    p++;
  }
  int found = 0;
  while (p < end && *p) {
    size_t remain = (size_t)(end - p);
    size_t len = strnlen(p, remain);
    if (len == remain) { free(data); return -1; }
    if (len == strlen(tag) && memcmp(p, tag, len) == 0) found = 1;
    p += len + 1;
  }
  free(data);
  return found;
}

static ssize_t find_pid(const struct process_info *items, size_t count, pid_t pid) {
  for (size_t i = 0; i < count; i++) if (items[i].pid == pid) return (ssize_t)i;
  return -1;
}

static int beneath(const struct process_info *items, size_t count, size_t index, pid_t root) {
  for (size_t i = 0; i < count; i++) {
    pid_t parent = items[index].ppid;
    if (parent == root) return 1;
    ssize_t next = find_pid(items, count, parent);
    if (next < 0 || (size_t)next == index) return 0;
    index = (size_t)next;
  }
  return 0;
}

int main(int argc, char **argv) {
  int identity_only = argc == 3 && !strcmp(argv[1], "--identity");
  if (!identity_only && argc != 5) return 64;
  char *end = NULL;
  const char *pid_text = argv[identity_only ? 2 : 1];
  long parsed = strtol(pid_text, &end, 10);
  if (!end || *end || parsed <= 1 || parsed > INT_MAX) return 64;
  pid_t root = (pid_t)parsed;
  struct process_info root_info;
  /* The broker starts both the upstream app-server and this helper. A PID
   * alone can be stale or reused: never accept an unrelated same-user process
   * as the root of a cleanup scan. Recheck this relationship before signals. */
  pid_t caller = getppid();
  if (caller <= 1 || root == getpid() || !info(root, &root_info) ||
      root_info.uid != getuid() || root_info.ppid != caller) return 65;
  if (identity_only) {
    printf("%" PRIu64 " %" PRIu64 "\n", root_info.start_sec, root_info.start_usec);
    return 0;
  }
  if (!argv[2][0] || strlen(argv[2]) > 160) return 64;
  for (const char *p = argv[2]; *p; p++) {
    if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
          (*p >= '0' && *p <= '9') || *p == '_' || *p == '-')) return 64;
  }
  for (int i = 3; i < 5; i++) {
    if (!argv[i][0]) return 64;
    for (const char *p = argv[i]; *p; p++) if (*p < '0' || *p > '9') return 64;
  }
  errno = 0;
  unsigned long long expected_sec = strtoull(argv[3], &end, 10);
  if (errno || !end || *end) return 64;
  errno = 0;
  unsigned long long expected_usec = strtoull(argv[4], &end, 10);
  if (errno || !end || *end || expected_usec >= 1000000) return 64;
  if (root_info.start_sec != expected_sec || root_info.start_usec != expected_usec) return 65;
  int bytes = proc_listallpids(NULL, 0);
  if (bytes <= 0 || bytes > MAX_PROCESSES) return 70;
  size_t capacity = (size_t)bytes + 256;
  if (capacity > MAX_PROCESSES) return 70;
  pid_t *pids = calloc(capacity, sizeof(*pids));
  struct process_info *items = calloc(capacity, sizeof(*items));
  if (!pids || !items) { free(pids); free(items); return 70; }
  int listed = proc_listallpids(pids, (int)(capacity * sizeof(*pids)));
  if (listed < 0 || (size_t)listed >= capacity) { free(pids); free(items); return 70; }
  size_t count = 0;
  for (int i = 0; i < listed; i++) {
    struct process_info p;
    if (pids[i] > 1 && info(pids[i], &p) && p.uid == getuid()) items[count++] = p;
  }
  free(pids);
  char tag[sizeof("AGENTOC_RUN_ID=") + 160];
  snprintf(tag, sizeof(tag), "AGENTOC_RUN_ID=%s", argv[2]);
  int incomplete = 0;
  for (size_t i = 0; i < count; i++) {
    if (items[i].pid == root || !beneath(items, count, i, root)) continue;
    int match = has_run_tag(items[i].pid, tag);
    if (match < 0 && same_process(&items[i])) incomplete = 1;
    if (match > 0) items[i].marked = 1;
  }
  /* Include descendants even when they have discarded their environment. */
  for (size_t pass = 0; pass < count; pass++) {
    int changed = 0;
    for (size_t i = 0; i < count; i++) {
      if (items[i].marked || items[i].pid == root) continue;
      ssize_t parent = find_pid(items, count, items[i].ppid);
      if (parent >= 0 && items[parent].marked) { items[i].marked = 1; changed = 1; }
    }
    if (!changed) break;
  }
  struct process_info current_root;
  if (getppid() != caller || !info(root, &current_root) || current_root.ppid != caller ||
      current_root.uid != root_info.uid || current_root.start_sec != root_info.start_sec ||
      current_root.start_usec != root_info.start_usec) { free(items); return 65; }
  for (size_t i = 0; i < count; i++) {
    if (items[i].marked && same_process(&items[i]) && kill(items[i].pid, SIGTERM) != 0 && errno != ESRCH) incomplete = 1;
  }
  usleep(500000);
  for (size_t i = 0; i < count; i++) {
    if (items[i].marked && same_process(&items[i]) && kill(items[i].pid, SIGKILL) != 0 && errno != ESRCH) incomplete = 1;
  }
  free(items);
  return incomplete ? 2 : 0;
}
