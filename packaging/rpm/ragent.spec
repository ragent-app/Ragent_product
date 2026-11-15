Name: ragent
Version: %{ragent_version}
Release: 1
Summary: Ragent local AI workbench
License: Apache-2.0
BuildArch: x86_64
%global __os_install_post %{nil}
AutoReqProv: no
Requires: glibc >= 2.34, systemd, shadow-utils, util-linux, acl, ca-certificates
Requires: bash, coreutils, findutils, gawk, grep, sed, procps-ng, openssl, polkit, python3
Requires: alsa-lib, atk, at-spi2-atk, at-spi2-core, cairo, cups-libs, dbus-libs
Requires: expat, gtk3, libgcc, libstdc++, libX11, libxcb, libXcomposite, libXdamage, libXext
Requires: libXfixes, libXrandr, libdrm, libxkbcommon, mesa-libgbm, nspr, nss, pango

%description
Ragent local AI workbench and service.

%install
mkdir -p %{buildroot}
cp -a %{ragent_stage}/. %{buildroot}/

%pre -f %{_sourcedir}/preinst
%post -f %{_sourcedir}/postinst
%preun -f %{_sourcedir}/prerm
%postun
if [ -d /run/systemd/system ]; then systemctl daemon-reload >/dev/null 2>&1 || :; fi

%files
%defattr(-,root,root,-)
%dir /etc/ragent
%config(noreplace) /etc/ragent/*.env
/opt/ragent
%attr(4755,root,root) /opt/ragent/Desktop/chrome-sandbox
%license /usr/share/licenses/ragent/LICENSE
/usr/bin/ragent
/usr/lib/ragent
/usr/lib/systemd/system/ragent*
/usr/share/applications/ragent.desktop
/usr/share/icons/hicolor/512x512/apps/ragent.png
