# Linux ARM64 package validation — 2026-11-15

The candidate `Ragent-0.0.1-linux-arm64.deb` has SHA-256 `5c409d683deb9e35ed22e33334bd38dc9488a2245cc283a54581b7925904f217`. Its BUILDINFO records source commit `4ae352df70db1770b2bb539a69d07d392db8139b` and internal package version `1.0.1`. The build used zstd level 6 and passed the staged ELF glibc 2.34 ceiling check. The package and matching BUILDINFO are retained on `oracle` in `/home/andy/ragent-linux-arm64-24dc3319/out-final/`.

The package was installed with apt in five fresh ARM64 systemd containers. apt resolved the declared Python 3 dependency without a manual installation. All five had the main service, privileged executor, lifecycle and supervisor services, their two sockets, and storage-GC timer active. In each container a cookie-free loopback HTML navigation returned a session, and `/api/auth/me` returned HTTP 200 with role `owner`. Separately, the generated owner credentials worked for password login and the local page returned HTTP 200. Credential values were not recorded. The Desktop app metadata was readable by an unprivileged user; `chrome-sandbox` was root-owned mode 4755, the packaged environment file mode 0640, and the initial credentials and owner auth file mode 0600.

| Container OS | Install and owner access | Stop/start, reinstall and remove |
| --- | --- | --- |
| Ubuntu 22.04.5 LTS | Passed | Passed |
| Ubuntu 24.04.5 LTS | Passed | Passed |
| Ubuntu 26.04.1 LTS | Passed | Passed |
| Debian 12.15 | Passed | Passed |
| Debian 13.6 | Passed | Passed |

Stop/start was followed by a same-version `1.0.1` reinstall and package removal. In every case the service was inactive after removal, the installed `/etc/ragent/ragent.env` remained, and the actual owner `auth.json` remained byte-identical through reinstall and removal. This does not establish an upgrade from an older version.

The containers used Docker 29.1.3 on the oracle ARM64 host with kernel `6.17.0-1019-oracle`, a private cgroup namespace and a separate cgroup2 mount. The package directory was mounted read-only; no package was installed on the host. These checks do not establish a host kernel or machine reboot, physical desktop or GPU behavior, or an actual provider Run. No container reboot was performed. They are limited container evidence and do not by themselves establish full platform validation.

The retained remote evidence directory also contains the five `final-<os>-install.log`, `final-<os>-reinstall.log`, and `final-<os>-remove.log` files, where `<os>` is `u22`, `u24`, `u26`, `d12`, or `d13`.
