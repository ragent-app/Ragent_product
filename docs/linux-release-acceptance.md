# Linux release acceptance

Linux packages are candidates until the exact package and OS/architecture
combination has passed release acceptance. A successful build or an ELF ABI
inspection alone is not evidence of installation or product support.

The intended Debian-package matrix is Ubuntu 22.04, 24.04 and 26.04 and
Debian 12 and 13, each on amd64 and arm64. The initial RPM target is RHEL 9
x86-64. Track every combination independently; a result on a derivative does
not establish a result on RHEL itself. No additional support is implied by
this target list.

For each candidate record the public and internal package versions, artifact
name and SHA-256, full source commit, build environment and toolchain, exact
OS version and architecture, and the date and outcome of each acceptance step.
Identify whether the environment is physical, a virtual machine or a container.
Container results do not establish reboot, kernel or physical-desktop behavior;
Xvfb results do not establish physical display behavior. Record failures and
untested steps rather than treating them as passes. Use the broader
[desktop release validation checklist](desktop-release-validation.md) for
the release gates.

On an isolated system with a real systemd init, exercise clean installation,
service and manager startup, a representative core workflow, upgrade from the
previous distributed package, reboot and recovery, and uninstall. Record
preservation of configuration and user data on upgrade and ordinary removal.
Test purge separately only in a disposable environment. Include actual desktop
and provider evidence where the release claims those capabilities.

Only publish or advertise a combination after its required gates are met.
Record any remaining limitations in the release notes and ensure the update
metadata and published artifact digest match the accepted package.
