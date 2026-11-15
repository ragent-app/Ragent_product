# Linux release acceptance

Linux packages are candidates until the exact package and OS/architecture
combination has passed installation compatibility checks. A successful build
or ELF ABI inspection alone is not evidence of installation compatibility.

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

Installation compatibility covers package installation and dependencies,
systemd service startup, local owner access, restart and ordinary removal,
including recorded configuration and data behavior. Record upgrade from an
available previous package separately. A container result must identify its missing kernel and
reboot coverage. Desktop display, actual provider Runs, device pairing and
other product functions are separate layers of evidence; do not imply that
they passed because installation did. Test purge only in a disposable system.
The broader checklist describes additional product release gates.

## Evidence for the 0.0.1 candidates

The amd64 DEB has internal version 1.0.1, source commit
`4ae352df70db1770b2bb539a69d07d392db8139b`, and SHA-256
`16a7b93e698151d317e42f085c0aa836535943aa79c65a8de07966ce5518a236`.
On isolated x86-64 KVM guests, Ubuntu 22.04.5, Ubuntu 24.04 and Debian 12.15
installed that package, started the service, returned a local owner session,
and started the service after reboot. Ordinary removal retained configuration
and data on Ubuntu 22.04 and Debian 12. On Ubuntu 24.04, upgrade from the
published 1.0.0 package, configuration preservation and ordinary removal were
checked with the preceding candidate from `6a2e549`; the final candidate adds
package dependencies and was reinstalled and checked for owner access and
reboot. The desktop manager displayed its account page on Ubuntu 24.04 using
Xvfb with the default sandbox. This is not a physical desktop or GPU result.

See [additional x86-64 results](linux-extra-x64-release-validation-20261115.md)
and [arm64 results](linux-arm64-release-validation-20261115.md) for their
exact packages, environments and limitations. The RPM built from commit
`ae0aee82457b275e038db4faf0a1d885f9f0d332` has SHA-256
`2d9642bc923d3c679ad7e10dc91b6a9f77462df01fec944f73addb5596d91d10`.
On a Rocky Linux 9.8 x86-64 KVM guest with SELinux enforcing, installation,
local owner access and service startup after reboot succeeded. Ordinary removal
stopped the service and retained `/var/lib/ragent` and generated credentials,
but removed the unmodified packaged `/etc/ragent/ragent.env`. No RPM upgrade
from an earlier release was available to validate. After reinstalling, changing
an existing setting and removing the package, the modified file was retained
as `/etc/ragent/ragent.env.rpmsave`, and the generated auth secret was unchanged.
An administrator must merge saved settings into the new file after reinstalling.
Rocky Linux is not enabled
for automatic RPM updates. RHEL 9 itself has not been tested; the Rocky result
does not establish RHEL 9 support. Real provider Runs, physical display and
device pairing remain unverified in this installation compatibility work.

Release notes and update metadata must identify the exact validated target and
artifact digest and state the remaining limitations. A candidate may be made
available with its unverified status clearly identified.
