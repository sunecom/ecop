"""Authenticated project storage for immutable ECOP calculation history."""
from __future__ import annotations

from contextlib import closing, contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sqlite3
import uuid


ID_PATTERNS = {
    'project': re.compile(r'^prj_[0-9a-f]{32}$'),
    'case': re.compile(r'^case_[0-9a-f]{32}$'),
    'version': re.compile(r'^cv_[0-9a-f]{32}$'),
    'export': re.compile(r'^exp_[0-9a-f]{32}$'),
    'run': re.compile(r'^[0-9a-f]{32}$'),
    'owner': re.compile(r'^usr_[0-9a-f]{32}$'),
}
NAME_LIMIT = 80
INPUT_LIMIT = 16 * 1024
RESULT_LIMIT = 5 * 1024 * 1024
EXPORT_LIMIT = 100 * 1024 * 1024


class NotFoundError(LookupError):
    pass


class ConflictError(RuntimeError):
    pass


class InvalidIdError(ValueError):
    pass


def authenticated_owner_id(scheme: str, username: str) -> str:
    if not isinstance(scheme, str) or not isinstance(username, str):
        raise ValueError('认证主体无效')
    canonical = f'{scheme.strip().casefold()}:{username.strip()}'.encode('utf-8')
    if not username.strip() or len(canonical) > 512:
        raise ValueError('认证主体无效')
    return 'usr_' + hashlib.sha256(canonical).hexdigest()[:32]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def _new_id(kind: str) -> str:
    prefixes = {'project': 'prj_', 'case': 'case_', 'version': 'cv_', 'export': 'exp_'}
    return prefixes[kind] + uuid.uuid4().hex


def _validate_id(value: str, kind: str) -> str:
    if not isinstance(value, str) or not ID_PATTERNS[kind].fullmatch(value):
        raise InvalidIdError(f'{kind} ID 无效')
    return value


def _validate_name(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError('名称必须为文本')
    value = value.strip()
    if not value or len(value) > NAME_LIMIT or any(ord(char) < 32 for char in value):
        raise ValueError(f'名称必须为 1 至 {NAME_LIMIT} 个可见字符')
    return value


def _json_text(value, limit: int, label: str) -> str:
    try:
        serialized = json.dumps(value, ensure_ascii=False, allow_nan=False,
                                separators=(',', ':'), sort_keys=True)
    except (TypeError, ValueError) as exc:
        raise ValueError(f'{label}必须为有限 JSON') from exc
    if not isinstance(value, dict) or len(serialized.encode('utf-8')) > limit:
        raise ValueError(f'{label}格式或大小不正确')
    return serialized


def _required_text(mapping: dict, key: str, label: str, limit: int = 256) -> str:
    value = mapping.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f'旧记录{label}无效')
    return value.strip()


def _legacy_record_values(data):
    result_json = _json_text(data, RESULT_LIMIT, '旧计算记录')
    module = data.get('module')
    inputs = data.get('inputs')
    results = data.get('results')
    comparison = data.get('comparison')
    if not isinstance(module, dict):
        raise ValueError('旧记录模块格式无效')
    if not isinstance(inputs, dict):
        raise ValueError('旧记录输入格式无效')
    if not isinstance(results, dict):
        raise ValueError('旧记录结果格式无效')
    if not isinstance(comparison, dict):
        raise ValueError('旧记录比较字段格式无效')
    run_id = _validate_id(data.get('run_id'), 'run')
    module_id = _required_text(module, 'id', '模块 ID', 80)
    module_name = _required_text(module, 'name', '模块名称', NAME_LIMIT)
    _required_text(module, 'unit_operation', '设备类型', 128)
    if _required_text(inputs, 'module', '输入模块 ID', 80) != module_id:
        raise ValueError('旧记录模块与输入不一致')
    _required_text(data, 'property_package', '物性包', 256)
    _required_text(comparison, 'metric', '比较指标', 128)
    _required_text(comparison, 'unit', '比较单位', 80)
    value = comparison.get('value')
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError('旧记录比较值无效')
    engine = _required_text(data, 'engine', '引擎版本', 128)
    build = _required_text(data, 'commit', '引擎构建', 256)
    timestamp = data.get('time')
    if timestamp is not None and (not isinstance(timestamp, str) or not timestamp.strip()):
        raise ValueError('旧记录时间无效')
    inputs_json = _json_text(inputs, INPUT_LIMIT, '旧工况输入')
    return result_json, run_id, inputs_json, engine, build, module_name, timestamp


class ProjectStore:
    def __init__(self, db_path: Path | str, export_root: Path | str):
        self.db_path = Path(db_path).resolve()
        self.export_root = Path(export_root).resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.export_root.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.db_path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys=ON')
        connection.execute('PRAGMA busy_timeout=5000')
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self):
        with self._connect() as connection:
            connection.execute('PRAGMA journal_mode=WAL')
            connection.executescript('''
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    legacy_key TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(owner_id, legacy_key)
                );
                CREATE INDEX IF NOT EXISTS projects_owner_idx
                    ON projects(owner_id, updated_at DESC);
                CREATE TABLE IF NOT EXISTS cases (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id),
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS cases_project_idx ON cases(project_id, created_at);
                CREATE TABLE IF NOT EXISTS case_versions (
                    id TEXT PRIMARY KEY,
                    case_id TEXT NOT NULL REFERENCES cases(id),
                    version_no INTEGER NOT NULL CHECK(version_no > 0),
                    parent_version_id TEXT REFERENCES case_versions(id),
                    inputs_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(case_id, version_no)
                );
                CREATE INDEX IF NOT EXISTS versions_case_idx
                    ON case_versions(case_id, version_no);
                CREATE TABLE IF NOT EXISTS calculation_records (
                    run_id TEXT PRIMARY KEY,
                    case_version_id TEXT NOT NULL REFERENCES case_versions(id),
                    result_json TEXT NOT NULL,
                    engine_version TEXT NOT NULL,
                    engine_build TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS records_version_idx
                    ON calculation_records(case_version_id, created_at);
                CREATE TABLE IF NOT EXISTS exports (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL UNIQUE REFERENCES calculation_records(run_id),
                    relative_path TEXT NOT NULL UNIQUE,
                    sha256 TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS legacy_imports (
                    source_key TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('imported', 'invalid')),
                    run_id TEXT,
                    imported_at TEXT NOT NULL
                );
                CREATE TRIGGER IF NOT EXISTS case_versions_no_update
                    BEFORE UPDATE ON case_versions BEGIN
                    SELECT RAISE(ABORT, 'case versions are immutable'); END;
                CREATE TRIGGER IF NOT EXISTS case_versions_no_delete
                    BEFORE DELETE ON case_versions BEGIN
                    SELECT RAISE(ABORT, 'case versions are immutable'); END;
                CREATE TRIGGER IF NOT EXISTS records_no_update
                    BEFORE UPDATE ON calculation_records BEGIN
                    SELECT RAISE(ABORT, 'calculation records are immutable'); END;
                CREATE TRIGGER IF NOT EXISTS records_no_delete
                    BEFORE DELETE ON calculation_records BEGIN
                    SELECT RAISE(ABORT, 'calculation records are immutable'); END;
                CREATE TRIGGER IF NOT EXISTS exports_no_update
                    BEFORE UPDATE ON exports BEGIN
                    SELECT RAISE(ABORT, 'exports are immutable'); END;
                CREATE TRIGGER IF NOT EXISTS exports_no_delete
                    BEFORE DELETE ON exports BEGIN
                    SELECT RAISE(ABORT, 'exports are immutable'); END;
            ''')

    @staticmethod
    def _owner(owner_id: str) -> str:
        return _validate_id(owner_id, 'owner')

    def _project_row(self, connection, owner_id, project_id):
        self._owner(owner_id)
        _validate_id(project_id, 'project')
        row = connection.execute(
            'SELECT * FROM projects WHERE id=? AND owner_id=?',
            (project_id, owner_id)).fetchone()
        if row is None:
            raise NotFoundError('项目不存在')
        return row

    def _version_row(self, connection, owner_id, version_id):
        self._owner(owner_id)
        _validate_id(version_id, 'version')
        row = connection.execute('''
            SELECT v.*, c.project_id, c.name AS case_name
            FROM case_versions v
            JOIN cases c ON c.id=v.case_id
            JOIN projects p ON p.id=c.project_id
            WHERE v.id=? AND p.owner_id=?
        ''', (version_id, owner_id)).fetchone()
        if row is None:
            raise NotFoundError('工况版本不存在')
        return row

    def create_project(self, owner_id: str, name: str):
        owner_id = self._owner(owner_id)
        name = _validate_name(name)
        project_id, timestamp = _new_id('project'), _now()
        with self._connect() as connection:
            connection.execute(
                'INSERT INTO projects(id, owner_id, name, created_at, updated_at) VALUES(?,?,?,?,?)',
                (project_id, owner_id, name, timestamp, timestamp))
        return {'id': project_id, 'name': name, 'created_at': timestamp,
                'updated_at': timestamp, 'case_count': 0, 'record_count': 0}

    def list_projects(self, owner_id: str):
        owner_id = self._owner(owner_id)
        with self._connect() as connection:
            rows = connection.execute('''
                SELECT p.id, p.name, p.created_at, p.updated_at,
                       COUNT(DISTINCT c.id) AS case_count,
                       COUNT(DISTINCT r.run_id) AS record_count
                FROM projects p
                LEFT JOIN cases c ON c.project_id=p.id
                LEFT JOIN case_versions v ON v.case_id=c.id
                LEFT JOIN calculation_records r ON r.case_version_id=v.id
                WHERE p.owner_id=?
                GROUP BY p.id
                ORDER BY p.updated_at DESC, p.id
            ''', (owner_id,)).fetchall()
        return [dict(row) for row in rows]

    def create_case(self, owner_id: str, project_id: str, name: str, inputs: dict):
        owner_id = self._owner(owner_id)
        name = _validate_name(name)
        inputs_json = _json_text(inputs, INPUT_LIMIT, '工况输入')
        case_id, version_id, timestamp = _new_id('case'), _new_id('version'), _now()
        with self._connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            self._project_row(connection, owner_id, project_id)
            connection.execute(
                'INSERT INTO cases(id, project_id, name, created_at) VALUES(?,?,?,?)',
                (case_id, project_id, name, timestamp))
            connection.execute('''
                INSERT INTO case_versions(id, case_id, version_no, parent_version_id,
                                          inputs_json, created_at)
                VALUES(?,?,1,NULL,?,?)
            ''', (version_id, case_id, inputs_json, timestamp))
            connection.execute('UPDATE projects SET updated_at=? WHERE id=?',
                               (timestamp, project_id))
        return {'id': case_id, 'name': name, 'created_at': timestamp,
                'versions': [self._version_dict(version_id, case_id, 1, None,
                                                 inputs_json, timestamp, [])]}

    @staticmethod
    def _version_dict(version_id, case_id, version_no, parent_id,
                      inputs_json, created_at, records):
        return {'id': version_id, 'case_id': case_id, 'version': version_no,
                'parent_version_id': parent_id, 'inputs': json.loads(inputs_json),
                'created_at': created_at, 'records': records}

    def create_version(self, owner_id: str, case_id: str, inputs: dict,
                       parent_version_id: str | None = None):
        owner_id = self._owner(owner_id)
        _validate_id(case_id, 'case')
        if parent_version_id is not None:
            _validate_id(parent_version_id, 'version')
        inputs_json = _json_text(inputs, INPUT_LIMIT, '工况输入')
        version_id, timestamp = _new_id('version'), _now()
        with self._connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            row = connection.execute('''
                SELECT c.project_id FROM cases c JOIN projects p ON p.id=c.project_id
                WHERE c.id=? AND p.owner_id=?
            ''', (case_id, owner_id)).fetchone()
            if row is None:
                raise NotFoundError('工况不存在')
            if parent_version_id is not None:
                parent = connection.execute(
                    'SELECT case_id FROM case_versions WHERE id=?',
                    (parent_version_id,)).fetchone()
                if parent is None or parent['case_id'] != case_id:
                    raise ConflictError('父版本不属于当前工况')
            next_version = connection.execute(
                'SELECT COALESCE(MAX(version_no),0)+1 FROM case_versions WHERE case_id=?',
                (case_id,)).fetchone()[0]
            connection.execute('''
                INSERT INTO case_versions(id, case_id, version_no, parent_version_id,
                                          inputs_json, created_at)
                VALUES(?,?,?,?,?,?)
            ''', (version_id, case_id, next_version, parent_version_id,
                  inputs_json, timestamp))
            connection.execute('UPDATE projects SET updated_at=? WHERE id=?',
                               (timestamp, row['project_id']))
        return self._version_dict(version_id, case_id, next_version,
                                  parent_version_id, inputs_json, timestamp, [])

    def copy_version(self, owner_id: str, version_id: str, project_id: str,
                     name: str):
        owner_id = self._owner(owner_id)
        name = _validate_name(name)
        case_id, new_version_id, timestamp = _new_id('case'), _new_id('version'), _now()
        with self._connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            source = self._version_row(connection, owner_id, version_id)
            self._project_row(connection, owner_id, project_id)
            connection.execute(
                'INSERT INTO cases(id, project_id, name, created_at) VALUES(?,?,?,?)',
                (case_id, project_id, name, timestamp))
            connection.execute('''
                INSERT INTO case_versions(id, case_id, version_no, parent_version_id,
                                          inputs_json, created_at)
                VALUES(?,?,1,?,?,?)
            ''', (new_version_id, case_id, version_id,
                  source['inputs_json'], timestamp))
            connection.execute('UPDATE projects SET updated_at=? WHERE id=?',
                               (timestamp, project_id))
        return {'id': case_id, 'name': name, 'created_at': timestamp,
                'versions': [self._version_dict(
                    new_version_id, case_id, 1, version_id,
                    source['inputs_json'], timestamp, [])]}

    def get_version(self, owner_id: str, version_id: str):
        with self._connect() as connection:
            row = self._version_row(connection, owner_id, version_id)
            records = self._record_rows(connection, version_id)
        version = self._version_dict(row['id'], row['case_id'], row['version_no'],
                                     row['parent_version_id'], row['inputs_json'],
                                     row['created_at'], records)
        version['project_id'] = row['project_id']
        version['case_name'] = row['case_name']
        return version

    @staticmethod
    def _record_rows(connection, version_id):
        rows = connection.execute('''
            SELECT r.*, e.id AS export_id, e.sha256 AS export_sha256,
                   e.size_bytes AS export_size_bytes
            FROM calculation_records r
            LEFT JOIN exports e ON e.run_id=r.run_id
            WHERE r.case_version_id=? ORDER BY r.created_at, r.run_id
        ''', (version_id,)).fetchall()
        records = []
        for row in rows:
            result = json.loads(row['result_json'])
            record = {'run_id': row['run_id'], 'created_at': row['created_at'],
                      'engine': row['engine_version'], 'commit': row['engine_build'],
                      'result': result}
            if row['export_id']:
                record['export'] = {'id': row['export_id'],
                                    'sha256': row['export_sha256'],
                                    'size_bytes': row['export_size_bytes']}
            records.append(record)
        return records

    def get_project(self, owner_id: str, project_id: str):
        with self._connect() as connection:
            project = self._project_row(connection, owner_id, project_id)
            case_rows = connection.execute(
                'SELECT * FROM cases WHERE project_id=? ORDER BY created_at, id',
                (project_id,)).fetchall()
            cases = []
            for case in case_rows:
                versions = []
                rows = connection.execute(
                    'SELECT * FROM case_versions WHERE case_id=? ORDER BY version_no',
                    (case['id'],)).fetchall()
                for version in rows:
                    versions.append(self._version_dict(
                        version['id'], case['id'], version['version_no'],
                        version['parent_version_id'], version['inputs_json'],
                        version['created_at'], self._record_rows(connection, version['id'])))
                cases.append({'id': case['id'], 'name': case['name'],
                              'created_at': case['created_at'], 'versions': versions})
        return {'id': project['id'], 'name': project['name'],
                'created_at': project['created_at'], 'updated_at': project['updated_at'],
                'cases': cases}

    def prepare_export(self, owner_id: str, project_id: str):
        owner_id = self._owner(owner_id)
        with self._connect() as connection:
            self._project_row(connection, owner_id, project_id)
        export_id = _new_id('export')
        relative = PurePosixPath('exports', owner_id, project_id, export_id + '.dwxml')
        path = (self.export_root / Path(*relative.parts)).resolve()
        if not path.is_relative_to(self.export_root):
            raise RuntimeError('导出目录映射无效')
        path.parent.mkdir(parents=True, exist_ok=True)
        return {'id': export_id, 'relative_path': relative.as_posix(), 'path': path,
                'project_id': project_id}

    def record_calculation(self, owner_id: str, version_id: str, result: dict,
                           export: dict | None):
        owner_id = self._owner(owner_id)
        result_json = _json_text(result, RESULT_LIMIT, '计算结果')
        run_id = _validate_id(result.get('run_id'), 'run')
        engine = str(result.get('engine', '')).strip()
        build = str(result.get('commit', '')).strip()
        if not engine or not build or len(engine) > 128 or len(build) > 256:
            raise ValueError('引擎版本信息无效')
        export_values = None
        with self._connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            version = self._version_row(connection, owner_id, version_id)
            if export is not None:
                export_id = _validate_id(export.get('id'), 'export')
                if export.get('project_id') != version['project_id']:
                    raise ConflictError('导出不属于当前项目')
                expected = self.prepare_export_path(
                    owner_id, version['project_id'], export_id)
                supplied = Path(export.get('path', '')).resolve()
                if supplied != expected or not supplied.is_file() or supplied.suffix != '.dwxml':
                    raise ValueError('导出文件映射无效')
                size = supplied.stat().st_size
                if not 0 < size <= EXPORT_LIMIT:
                    raise ValueError('导出文件大小无效')
                export_values = (export_id, run_id, export['relative_path'],
                                 sha256_file(supplied), size, _now())
            timestamp = str(result.get('time') or _now())
            connection.execute('''
                INSERT INTO calculation_records(run_id, case_version_id, result_json,
                                                engine_version, engine_build, created_at)
                VALUES(?,?,?,?,?,?)
            ''', (run_id, version_id, result_json, engine, build, timestamp))
            if export_values:
                connection.execute('''
                    INSERT INTO exports(id, run_id, relative_path, sha256, size_bytes, created_at)
                    VALUES(?,?,?,?,?,?)
                ''', export_values)
            connection.execute('UPDATE projects SET updated_at=? WHERE id=?',
                               (_now(), version['project_id']))
        record = {'run_id': run_id, 'created_at': timestamp, 'engine': engine,
                  'commit': build, 'result': json.loads(result_json)}
        if export_values:
            record['export'] = {'id': export_values[0], 'sha256': export_values[3],
                                'size_bytes': export_values[4]}
        return record

    def prepare_export_path(self, owner_id: str, project_id: str, export_id: str) -> Path:
        owner_id = self._owner(owner_id)
        _validate_id(project_id, 'project')
        _validate_id(export_id, 'export')
        relative = PurePosixPath('exports', owner_id, project_id, export_id + '.dwxml')
        path = (self.export_root / Path(*relative.parts)).resolve()
        if not path.is_relative_to(self.export_root):
            raise ValueError('导出路径无效')
        return path

    def get_export(self, owner_id: str, export_id: str):
        owner_id = self._owner(owner_id)
        _validate_id(export_id, 'export')
        with self._connect() as connection:
            row = connection.execute('''
                SELECT e.*, p.id AS project_id FROM exports e
                JOIN calculation_records r ON r.run_id=e.run_id
                JOIN case_versions v ON v.id=r.case_version_id
                JOIN cases c ON c.id=v.case_id
                JOIN projects p ON p.id=c.project_id
                WHERE e.id=? AND p.owner_id=?
            ''', (export_id, owner_id)).fetchone()
        if row is None:
            raise NotFoundError('导出文件不存在')
        expected_relative = PurePosixPath(
            'exports', owner_id, row['project_id'], export_id + '.dwxml').as_posix()
        if row['relative_path'] != expected_relative:
            raise RuntimeError('导出映射不一致')
        path = self.prepare_export_path(owner_id, row['project_id'], export_id)
        if not path.is_file() or sha256_file(path) != row['sha256']:
            raise ConflictError('导出文件缺失或校验失败')
        return {'id': export_id, 'run_id': row['run_id'], 'sha256': row['sha256'],
                'size_bytes': row['size_bytes'], 'path': path}

    def _record_for_owner(self, connection, owner_id, run_id):
        self._owner(owner_id)
        _validate_id(run_id, 'run')
        row = connection.execute('''
            SELECT r.* FROM calculation_records r
            JOIN case_versions v ON v.id=r.case_version_id
            JOIN cases c ON c.id=v.case_id
            JOIN projects p ON p.id=c.project_id
            WHERE r.run_id=? AND p.owner_id=?
        ''', (run_id, owner_id)).fetchone()
        if row is None:
            raise NotFoundError('计算记录不存在')
        return json.loads(row['result_json'])

    @staticmethod
    def _comparison_signature(result):
        module = result.get('module') or {}
        comparison = result.get('comparison') or {}
        material = result.get('material_system') or {}
        inputs = result.get('inputs') or {}
        composition = material.get('requested_mass_fractions') or inputs.get('composition')
        composition_signature = (json.dumps(composition, sort_keys=True, separators=(',', ':'))
                                 if isinstance(composition, dict) else None)
        return (module.get('id'), module.get('unit_operation'), module.get('unit_tag'),
                comparison.get('metric'), comparison.get('unit'),
                result.get('property_package'), material.get('id') or inputs.get('system'),
                material.get('composition_basis') or inputs.get('composition_basis'),
                composition_signature)

    def compare_records(self, owner_id: str, run_a: str, run_b: str):
        if run_a == run_b:
            raise ConflictError('请选择两个不同计算记录')
        with self._connect() as connection:
            first = self._record_for_owner(connection, owner_id, run_a)
            second = self._record_for_owner(connection, owner_id, run_b)
        if self._comparison_signature(first) != self._comparison_signature(second):
            raise ConflictError('所选记录的模块、设备、物性或指标不可比较')
        first_value = first['comparison'].get('value')
        second_value = second['comparison'].get('value')
        if (isinstance(first_value, bool) or isinstance(second_value, bool) or
                not isinstance(first_value, (int, float)) or
                not isinstance(second_value, (int, float))):
            raise ConflictError('所选记录缺少可比较指标')
        delta = second_value - first_value
        relative = None if first_value == 0 else delta / abs(first_value) * 100
        return {'run_a': run_a, 'run_b': run_b,
                'metric': first['comparison']['metric'],
                'label': first['comparison'].get('label', ''),
                'unit': first['comparison']['unit'],
                'value_a': first_value, 'value_b': second_value,
                'delta': delta, 'relative_percent': relative}

    def migrate_legacy_runs(self, owner_id: str, runs_dir: Path | str):
        owner_id = self._owner(owner_id)
        runs_dir = Path(runs_dir)
        counts = {'imported': 0, 'skipped': 0, 'invalid': 0}
        if not runs_dir.is_dir():
            return counts
        paths = sorted(runs_dir.glob('*.json'))
        if not paths:
            return counts
        with self._connect() as connection:
            row = connection.execute(
                'SELECT id FROM projects WHERE owner_id=? AND legacy_key=?',
                (owner_id, 'runs-v1')).fetchone()
            if row:
                legacy_project = row['id']
            else:
                legacy_project, timestamp = _new_id('project'), _now()
                connection.execute('''
                    INSERT INTO projects(id, owner_id, name, legacy_key, created_at, updated_at)
                    VALUES(?,?,?,'runs-v1',?,?)
                ''', (legacy_project, owner_id, '历史记录迁移', timestamp, timestamp))
        for path in paths:
            source_key = str(path.resolve()) + ':' + sha256_file(path)
            with self._connect() as connection:
                if connection.execute(
                        'SELECT 1 FROM legacy_imports WHERE source_key=?',
                        (source_key,)).fetchone():
                    counts['skipped'] += 1
                    continue
            try:
                data = json.loads(path.read_text(encoding='utf-8'))
                (result_json, run_id, inputs_json, engine, build,
                 module_name, recorded_at) = _legacy_record_values(data)
                case_name = _validate_name(f'{module_name} {run_id[:8]}')
                with self._connect() as connection:
                    connection.execute('BEGIN IMMEDIATE')
                    if connection.execute(
                            'SELECT 1 FROM calculation_records WHERE run_id=?',
                            (run_id,)).fetchone():
                        connection.execute('''
                            INSERT INTO legacy_imports(source_key, owner_id, status, run_id, imported_at)
                            VALUES(?,?,'imported',?,?)
                        ''', (source_key, owner_id, run_id, _now()))
                        counts['skipped'] += 1
                        continue
                    case_id, version_id, timestamp = _new_id('case'), _new_id('version'), _now()
                    connection.execute(
                        'INSERT INTO cases(id, project_id, name, created_at) VALUES(?,?,?,?)',
                        (case_id, legacy_project, case_name, timestamp))
                    connection.execute('''
                        INSERT INTO case_versions(id, case_id, version_no, inputs_json, created_at)
                        VALUES(?,?,1,?,?)
                    ''', (version_id, case_id, inputs_json, timestamp))
                    connection.execute('''
                        INSERT INTO calculation_records(run_id, case_version_id, result_json,
                                                        engine_version, engine_build, created_at)
                        VALUES(?,?,?,?,?,?)
                    ''', (run_id, version_id, result_json, engine, build,
                          recorded_at or timestamp))
                    connection.execute('''
                        INSERT INTO legacy_imports(source_key, owner_id, status, run_id, imported_at)
                        VALUES(?,?,'imported',?,?)
                    ''', (source_key, owner_id, run_id, timestamp))
                    connection.execute('UPDATE projects SET updated_at=? WHERE id=?',
                                       (timestamp, legacy_project))
                counts['imported'] += 1
            except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
                with self._connect() as connection:
                    connection.execute('''
                        INSERT OR IGNORE INTO legacy_imports(
                            source_key, owner_id, status, run_id, imported_at)
                        VALUES(?,?,'invalid',NULL,?)
                    ''', (source_key, owner_id, _now()))
                counts['invalid'] += 1
        return counts

    def backup_to(self, destination: Path | str):
        destination = Path(destination).resolve()
        if destination == self.db_path:
            raise ValueError('备份路径不能覆盖运行数据库')
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            destination.unlink()
        with self._connect() as source, closing(sqlite3.connect(destination)) as target:
            source.backup(target)
            target.execute('PRAGMA foreign_keys=ON')
            integrity = target.execute('PRAGMA integrity_check').fetchone()[0]
            if integrity != 'ok':
                raise RuntimeError('SQLite 备份完整性检查失败')
            projects = target.execute('SELECT COUNT(*) FROM projects').fetchone()[0]
            versions = target.execute('SELECT COUNT(*) FROM case_versions').fetchone()[0]
            records = target.execute('SELECT COUNT(*) FROM calculation_records').fetchone()[0]
        return {'path': destination, 'sha256': sha256_file(destination),
                'projects': projects, 'versions': versions, 'records': records}
