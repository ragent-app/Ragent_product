/* Same-user service-instance identification, not an authorization boundary.
 * Never print the inspected environment: it can contain credentials. */
#include <sys/types.h>
#include <sys/sysctl.h>
#include <libproc.h>
#include <unistd.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_ARGS (1024 * 1024)

int main(int argc, char **argv) {
  if (argc != 5) return 2;
  char *end = NULL;
  long n = strtol(argv[1], &end, 10);
  if (!end || *end || n <= 1 || n > INT_MAX || argv[2][0] != '/' || argv[3][0] != '/') return 2;
  pid_t pid = (pid_t)n;
  struct proc_bsdinfo before, after;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != sizeof(before)
      || before.pbi_uid != getuid()) return 2;
  int mib[] = { CTL_KERN, KERN_PROCARGS2, pid };
  size_t size = 0;
  if (sysctl(mib, 3, NULL, &size, NULL, 0) != 0 || size < sizeof(int) || size > MAX_ARGS) return 2;
  char *data = malloc(size);
  if (!data) return 2;
  int result = 2;
  if (sysctl(mib, 3, data, &size, NULL, 0) != 0 || size < sizeof(int)) goto done;
  int count;
  memcpy(&count, data, sizeof(count));
  if (count < 0 || count > 65536) goto done;
  char *p = data + sizeof(count), *limit = data + size;
  while (p < limit && *p) p++;
  while (p < limit && !*p) p++;
  for (int i = 0; i < count; i++) {
    while (p < limit && *p) p++;
    if (p == limit) goto done;
    p++;
  }
  const char *home = NULL, *config = NULL, *instance = NULL;
  while (p < limit && *p) {
    size_t len = strnlen(p, (size_t)(limit - p));
    if (len == (size_t)(limit - p)) goto done;
    if (strncmp(p, "HOME=", 5) == 0) { if (home) goto done; home = p + 5; }
    if (strncmp(p, "AGENTOC_CONFIG_DIR=", 19) == 0) { if (config) goto done; config = p + 19; }
    if (strncmp(p, "AGENTOC_INSTANCE_ROOT=", 22) == 0) { if (instance) goto done; instance = p + 22; }
    p += len + 1;
  }
  if (!home || strcmp(home, argv[2]) != 0) { result = 1; goto done; }
  if (!config || !*config) {
    size_t length = strlen(home) + sizeof("/.config/agentoc");
    char *default_config = malloc(length);
    if (!default_config) goto done;
    snprintf(default_config, length, "%s/.config/agentoc", home);
    int matches = strcmp(default_config, argv[3]) == 0;
    free(default_config);
    if (!matches) { result = 1; goto done; }
  } else if (strcmp(config, argv[3]) != 0) { result = 1; goto done; }
  if (strcmp(instance ? instance : "", argv[4]) != 0) { result = 1; goto done; }
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != sizeof(after)
      || before.pbi_uid != after.pbi_uid || before.pbi_start_tvsec != after.pbi_start_tvsec
      || before.pbi_start_tvusec != after.pbi_start_tvusec) goto done;
  result = 0;
done:
  free(data);
  return result;
}
