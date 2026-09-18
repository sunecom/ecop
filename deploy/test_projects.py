"""P3 project, immutable history, export mapping, and recovery tests."""
import json
from contextlib import closing
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '本地演示'))

import project_store


SAMPLE = {
    'module': 'evaporation',
    'flow_kg_h': 1000.0,
    'temperature_C': 25.0,
    'pressure_kPa': 101.325,
    'vapor_percent': 30.0,
}


def result(run_id='a' * 32, value=210.5, module='evaporation', package='Steam Tables'):
    return {
        'run_id': run_id,
        'time': '2026-09-19 02:00:00',
        'module': {'id': module, 'name': '目标汽化计算', 'unit_operation': 'Heater'},
        'inputs': dict(SAMPLE, module=module),
        'engine': 'DWSIM 10.2.8',
        'commit': 'test-build',
        'property_package': package,
        'results': {'heat_duty_kW': value},
        'comparison': {'metric': 'heat_duty_kW', 'label': '热负荷',
                       'unit': 'kW', 'value': value},
        'raw': {'solve': {'ok': True}},
    }


class ProjectStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.store = project_store.ProjectStore(root / 'projects.sqlite3', root / 'exports')
        self.owner = project_store.authenticated_owner_id('basic', 'ecop')
        self.other = project_store.authenticated_owner_id('basic', 'other')

    def tearDown(self):
        self.temp.cleanup()

    def create_version(self, owner=None, name='基准项目', case_name='汽化基准'):
        owner = owner or self.owner
        project = self.store.create_project(owner, name)
        case = self.store.create_case(owner, project['id'], case_name, SAMPLE)
        return project, case, case['versions'][0]

    def test_authenticated_owner_id_is_stable_and_opaque(self):
        first = project_store.authenticated_owner_id('basic', 'ecop')
        second = project_store.authenticated_owner_id('basic', 'ecop')
        self.assertEqual(first, second)
        self.assertRegex(first, r'^usr_[0-9a-f]{32}$')
        self.assertNotIn('ecop', first)
        self.assertNotEqual(first, self.other)

    def test_project_versions_are_stable_and_immutable(self):
        project, case, first = self.create_version()
        changed = dict(SAMPLE, vapor_percent=45.0)
        second = self.store.create_version(
            self.owner, case['id'], changed, parent_version_id=first['id'])
        opened = self.store.get_project(self.owner, project['id'])
        versions = opened['cases'][0]['versions']
        self.assertEqual([item['version'] for item in versions], [1, 2])
        self.assertEqual(versions[0]['inputs']['vapor_percent'], 30.0)
        self.assertEqual(versions[1]['inputs']['vapor_percent'], 45.0)
        self.assertEqual(versions[1]['parent_version_id'], versions[0]['id'])
        with closing(sqlite3.connect(self.store.db_path)) as connection:
            with self.assertRaises(sqlite3.DatabaseError):
                connection.execute(
                    'UPDATE case_versions SET inputs_json=? WHERE id=?',
                    ('{}', first['id']))

    def test_owner_scope_blocks_cross_user_reads_and_writes(self):
        project, case, version = self.create_version()
        for action in (
                lambda: self.store.get_project(self.other, project['id']),
                lambda: self.store.create_version(self.other, case['id'], SAMPLE),
                lambda: self.store.get_version(self.other, version['id'])):
            with self.subTest(action=action), self.assertRaises(project_store.NotFoundError):
                action()
        self.assertEqual(self.store.list_projects(self.other), [])

    def test_copy_and_compatible_comparison_preserve_history(self):
        project, case, version = self.create_version()
        copied = self.store.copy_version(self.owner, version['id'], project['id'], '复制工况')
        self.assertNotEqual(copied['id'], case['id'])
        self.assertEqual(copied['versions'][0]['inputs'], SAMPLE)
        first_export = self.store.prepare_export(self.owner, project['id'])
        second_export = self.store.prepare_export(self.owner, project['id'])
        first_export['path'].write_text('<DWSIM />', encoding='utf-8')
        second_export['path'].write_text('<DWSIM changed="1" />', encoding='utf-8')
        self.store.record_calculation(
            self.owner, version['id'], result('a' * 32, 200.0), first_export)
        copied_version = copied['versions'][0]
        self.store.record_calculation(
            self.owner, copied_version['id'], result('b' * 32, 250.0), second_export)
        comparison = self.store.compare_records(self.owner, 'a' * 32, 'b' * 32)
        self.assertEqual(comparison['delta'], 50.0)
        self.assertEqual(comparison['unit'], 'kW')
        self.assertEqual(comparison['relative_percent'], 25.0)

    def test_incompatible_comparison_is_rejected(self):
        project, _, version = self.create_version()
        second_case = self.store.create_case(
            self.owner, project['id'], '泵', dict(SAMPLE, module='pump'))
        self.store.record_calculation(self.owner, version['id'], result('c' * 32), None)
        self.store.record_calculation(
            self.owner, second_case['versions'][0]['id'],
            result('d' * 32, module='pump'), None)
        with self.assertRaisesRegex(project_store.ConflictError, '不可比较'):
            self.store.compare_records(self.owner, 'c' * 32, 'd' * 32)

    def test_export_mapping_never_accepts_client_paths(self):
        project, _, version = self.create_version()
        export = self.store.prepare_export(self.owner, project['id'])
        self.assertTrue(export['path'].is_relative_to(self.store.export_root))
        self.assertNotIn('..', export['relative_path'])
        export['path'].write_text('<DWSIM />', encoding='utf-8')
        stored = self.store.record_calculation(
            self.owner, version['id'], result('e' * 32), export)
        mapping = self.store.get_export(self.owner, stored['export']['id'])
        self.assertEqual(mapping['sha256'], project_store.sha256_file(export['path']))
        self.assertEqual(mapping['path'], export['path'])
        for invalid in ('../secret', '/etc/passwd', 'exp_bad/slash', 'not-an-id'):
            with self.subTest(invalid=invalid), self.assertRaises(project_store.InvalidIdError):
                self.store.get_export(self.owner, invalid)
        with self.assertRaises(project_store.NotFoundError):
            self.store.get_export(self.other, stored['export']['id'])

    def test_legacy_migration_is_idempotent_and_restart_persists(self):
        runs = Path(self.temp.name) / 'runs'
        runs.mkdir()
        (runs / 'legacy.json').write_text(
            json.dumps(result('f' * 32), ensure_ascii=False), encoding='utf-8')
        (runs / 'broken.json').write_text('{broken', encoding='utf-8')
        first = self.store.migrate_legacy_runs(self.owner, runs)
        second = self.store.migrate_legacy_runs(self.owner, runs)
        self.assertEqual(first, {'imported': 1, 'skipped': 0, 'invalid': 1})
        self.assertEqual(second, {'imported': 0, 'skipped': 2, 'invalid': 0})
        reopened = project_store.ProjectStore(self.store.db_path, self.store.export_root)
        projects = reopened.list_projects(self.owner)
        legacy = next(item for item in projects if item['name'] == '历史记录迁移')
        detail = reopened.get_project(self.owner, legacy['id'])
        self.assertEqual(detail['cases'][0]['versions'][0]['records'][0]['run_id'], 'f' * 32)

    def test_online_backup_opens_with_same_counts(self):
        self.create_version()
        backup_path = Path(self.temp.name) / 'backup' / 'projects.sqlite3'
        summary = self.store.backup_to(backup_path)
        restored = project_store.ProjectStore(backup_path, Path(self.temp.name) / 'restored-exports')
        self.assertEqual(summary['projects'], 1)
        self.assertEqual(len(restored.list_projects(self.owner)), 1)
        self.assertEqual(summary['sha256'], project_store.sha256_file(backup_path))

    def test_names_and_json_are_bounded(self):
        for name in ('', ' ' * 3, 'x' * 81, 'bad\nname'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.store.create_project(self.owner, name)
        project = self.store.create_project(self.owner, '项目')
        with self.assertRaises(ValueError):
            self.store.create_case(self.owner, project['id'], '工况', {'value': float('nan')})

    def test_browser_contract_has_persistent_workspace_without_path_upload(self):
        page = (ROOT / '本地演示' / 'index.html').read_text(encoding='utf-8')
        script_path = ROOT / '本地演示' / 'project_ui.js'
        self.assertIn('id="projects"', page)
        self.assertIn('id="projectCreate"', page)
        self.assertIn('DWSIM 流程文件', page)
        self.assertNotIn('type="file"', page)
        self.assertTrue(script_path.is_file())
        script = script_path.read_text(encoding='utf-8')
        self.assertIn('/api/projects', script)
        self.assertIn('/calculate', script)
        self.assertIn('/api/exports/', script)
        self.assertNotIn('server_path', script)
        compose = (ROOT / 'deploy' / 'compose.yaml').read_text(encoding='utf-8')
        self.assertIn('ECOP_PROJECTS_DIR: /projects', compose)
        self.assertGreaterEqual(compose.count('projects:/projects'), 2)


if __name__ == '__main__':
    unittest.main()
