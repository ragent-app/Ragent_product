import datetime as dt
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('traffic_collector', pathlib.Path(__file__).resolve().parents[1] / 'infrastructure/admin-console/traffic-collector.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class TrafficCollectorTests(unittest.TestCase):
    def test_deltas_resets_and_month_boundaries(self):
        state = {'months': {}}
        now = dt.datetime(2026, 11, 30, 23, 58, tzinfo=dt.timezone.utc)
        def sample(rx, tx, boot='boot-a', interface='eth0', offset=0):
            collector.update(state, {'rx': rx, 'tx': tx, 'boot': boot, 'interface': interface}, now + dt.timedelta(minutes=offset))
        sample(100, 200)
        sample(150, 240, offset=1)
        self.assertEqual((state['months']['2026-11']['rx'], state['months']['2026-11']['tx']), (50, 40))
        sample(200, 300, offset=2)
        self.assertEqual(state['months']['2026-12']['rx'], 0)
        self.assertTrue(state['months']['2026-12']['partial'])
        sample(230, 360, offset=3)
        sample(5, 10, boot='boot-b', offset=4)
        sample(15, 25, boot='boot-b', offset=5)
        self.assertEqual((state['months']['2026-12']['rx'], state['months']['2026-12']['tx']), (40, 75))


if __name__ == '__main__':
    unittest.main()
