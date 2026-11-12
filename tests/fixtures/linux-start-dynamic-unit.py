#!/usr/bin/env python3
"""Test-only D-Bus launcher for one uniquely named transient systemd unit."""
import os
import sys
import dbus

if os.geteuid() != 0 or len(sys.argv) < 6:
    raise SystemExit('usage: UNIT USER ROOT RUNTIME ABSOLUTE_EXECUTABLE [ARGS...]')
unit, user, root, runtime, *command = sys.argv[1:]
if not unit.startswith('agentoc-idmap-single-') or not unit.endswith('.service'):
    raise SystemExit('invalid fixture unit')
if not user.startswith('agentoc-map-') or not root.startswith('/srv/agentoc-idmap-single-') or not runtime.startswith('agentoc-idmap-single-') or '/' in runtime:
    raise SystemExit('invalid fixture identity or root')
if not os.path.isabs(command[0]):
    raise SystemExit('executable must be absolute')

props = [
    ('Description', dbus.String('Isolated Ragent dynamic UID fixture', variant_level=1)),
    ('Type', dbus.String('exec', variant_level=1)),
    ('User', dbus.String(user, variant_level=1)),
    ('DynamicUser', dbus.Boolean(True, variant_level=1)),
    ('KillMode', dbus.String('control-group', variant_level=1)),
    ('NoNewPrivileges', dbus.Boolean(True, variant_level=1)),
    ('ReadWritePaths', dbus.Array([root], signature='s', variant_level=1)),
    ('RuntimeDirectory', dbus.Array([runtime], signature='s', variant_level=1)),
    ('RuntimeDirectoryMode', dbus.UInt32(0o700, variant_level=1)),
    ('ExecStartEx', dbus.Array([
        dbus.Struct((command[0], dbus.Array(command, signature='s'),
                     dbus.Array(['no-setuid'], signature='s')), signature='sasas')
    ], signature='(sasas)', variant_level=1)),
]
manager = dbus.Interface(dbus.SystemBus().get_object('org.freedesktop.systemd1',
    '/org/freedesktop/systemd1'), 'org.freedesktop.systemd1.Manager')
manager.StartTransientUnit(unit, 'fail', dbus.Array(props, signature='(sv)'),
                           dbus.Array([], signature='(sa(sv))'))
