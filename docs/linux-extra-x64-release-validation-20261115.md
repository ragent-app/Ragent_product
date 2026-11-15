# Additional Linux x64 release validation — 2026-11-15

The candidate is `ragent_0.0.1_amd64.deb`, public version 0.0.1,
internal package version 1.0.1, SHA-256
`16a7b93e698151d317e42f085c0aa836535943aa79c65a8de07966ce5518a236`,
built from source commit `4ae352df70db1770b2bb539a69d07d392db8139b`
(build provenance is in the release build record). Both environments below are isolated x86-64 KVM
guests with systemd, using official cloud images and real package dependencies.
They are not physical machines; no real provider credentials or provider Run
were exercised.

## Ubuntu 26.04.1 LTS

- Installed the prior distributed 1.0.0 DEB, then upgraded it with the exact
  candidate through apt; candidate digest matched in the guest and dpkg reported
  version 1.0.1. This is an upgrade result, not a clean candidate installation.
- The service became active, the local browser-style HTML request returned 200,
  and the local session's `/api/auth/me` returned the owner role.
- After guest reboot the service became active again. The generated
  `/etc/ragent/ragent.env` and `/var/lib/ragent/config/auth.json` retained the
  same SHA-256 before and after reboot and ordinary package removal. Removal
  completed and the service reported inactive.
- The desktop process ran under Xvfb with its default sandbox for 20 seconds
  until the timeout terminated it. No window image or visible UI evidence was
  captured, so this does not establish desktop interaction or physical display
  compatibility. GPU/zygote termination messages appeared during timeout cleanup.

## Debian 13.7

- Installed the prior distributed 1.0.0 DEB, then upgraded with the exact
  candidate through apt. The candidate digest matched in the guest and dpkg
  reported 1.0.1; this is not a clean candidate installation. The generated
  environment and authentication files had identical SHA-256 values before
  and after the upgrade.
- The service was active, the local browser-style HTML request returned 200,
  and `/api/auth/me` returned the owner role. After guest reboot the service
  became active again.
- With no sandbox-disabling flag, Xvfb exposed a 1180 × 800
  `ragent-desktop-manager` window to `xwininfo`. No screenshot, desktop
  interaction, real display or physical GPU was verified.
- Ordinary apt removal completed, the service reported inactive, and the
  generated environment and authentication files retained their pre-upgrade
  SHA-256 values.
