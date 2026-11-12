#!/usr/bin/env python3
"""Persist UTC month-to-date counters for the default-route network interface."""
import datetime as dt
import fcntl
import json
import os
import pathlib
import tempfile

ROOT = pathlib.Path('/var/lib/agentoc-admin')
STATE = ROOT / 'traffic.json'


def read_counter():
    rows = pathlib.Path('/proc/net/route').read_text().splitlines()[1:]
    routes = [row.split() for row in rows]
    routes = [row for row in routes if len(row) > 7 and row[1] == '00000000' and int(row[3], 16) & 1]
    if not routes:
        raise RuntimeError('default network interface unavailable')
    interface = min(routes, key=lambda row: int(row[6]))[0]
    if not interface or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-' for c in interface):
        raise RuntimeError('invalid interface name')
    stats = pathlib.Path('/sys/class/net') / interface / 'statistics'
    return {'interface': interface, 'boot': pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'rx': int((stats / 'rx_bytes').read_text()), 'tx': int((stats / 'tx_bytes').read_text())}


def update(state, current, timestamp):
    month = timestamp.strftime('%Y-%m')
    current = {**current, 'at': timestamp.isoformat(), 'month': month}
    months = state.setdefault('months', {})
    row = months.setdefault(month, {'rx': 0, 'tx': 0, 'partial': True, 'startedAt': current['at']})
    previous = state.get('previous')
    if previous and all(previous.get(k) == current[k] for k in ('boot', 'interface', 'month')):
        if current['rx'] >= previous['rx'] and current['tx'] >= previous['tx']:
            row['rx'] += current['rx'] - previous['rx']
            row['tx'] += current['tx'] - previous['tx']
        else:
            row['partial'] = True
    else:
        row['partial'] = True
    row['updatedAt'] = current['at']
    row['interface'] = current['interface']
    state['previous'] = current
    for old in sorted(months)[:-24]:
        del months[old]
    return state


def main():
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (ROOT / 'traffic.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            state = json.loads(STATE.read_text())
            if not isinstance(state, dict) or not isinstance(state.get('months'), dict):
                raise ValueError('invalid traffic state')
        except FileNotFoundError:
            state = {'months': {}}
        state = update(state, read_counter(), dt.datetime.now(dt.timezone.utc))
        fd, name = tempfile.mkstemp(prefix='.traffic-', dir=ROOT)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(state, stream, separators=(',', ':'))
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(name, 0o600)
            os.replace(name, STATE)
        finally:
            if os.path.exists(name):
                os.unlink(name)


if __name__ == '__main__':
    main()
