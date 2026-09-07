#!/usr/bin/env python3
"""Portable, network-free scheduling and fenced leases for agent-led skill updates."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid

WEEK = 7 * 86400
LEASE = 30 * 60


def operate(db_path, identity, action, token=None, outcome=None, revision=None, now=None, approved_revision=None):
    now = time.time() if now is None else now
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    con = sqlite3.connect(db_path, timeout=10, isolation_level=None)
    try:
        con.execute('CREATE TABLE IF NOT EXISTS checks (identity TEXT PRIMARY KEY, data TEXT NOT NULL)')
        con.execute('BEGIN IMMEDIATE')
        row = con.execute('SELECT data FROM checks WHERE identity=?', (identity,)).fetchone()
        state = json.loads(row[0]) if row else {}
        if action == 'claim':
            if state.get('disabled'):
                result = {'status': 'disabled'}
            elif state.get('expires_at', 0) > now:
                result = {'status': 'busy', 'retry_at': state['expires_at']}
            elif approved_revision and approved_revision != state.get('offered_revision'):
                raise ValueError('Approval must match the previously offered revision; check and offer the update first.')
            elif not approved_revision and state.get('next_check_at', 0) > now:
                result = {'status': 'not_due', 'next_check_at': state['next_check_at']}
            else:
                state.update(token=uuid.uuid4().hex, expires_at=now + LEASE)
                state['approved_revision'] = approved_revision
                result = {'status': 'claimed', 'token': state['token'], 'expires_at': state['expires_at']}
                if state.get('offered_revision'):
                    result['offered_revision'] = state['offered_revision']
        elif action in ('renew', 'finish'):
            if not token or token != state.get('token') or state.get('expires_at', 0) <= now:
                raise ValueError('Lease lost or expired; stop updating and claim again.')
            if action == 'renew':
                state['expires_at'] = now + LEASE
                result = {'status': 'renewed', 'expires_at': state['expires_at']}
            else:
                if outcome not in ('unchanged', 'updated', 'available', 'blocked', 'error'):
                    raise ValueError('Choose unchanged, updated, available, blocked, or error.')
                if outcome in ('unchanged', 'updated', 'available') and not revision:
                    raise ValueError('A verified upstream revision is required.')
                if outcome == 'updated' and revision != state.get('approved_revision'):
                    raise ValueError('Installation requires approval for this offered revision.')
                state.update(last_attempt_at=now, outcome=outcome,
                             next_check_at=now + (WEEK if outcome in ('updated', 'unchanged', 'available') else 86400 if outcome == 'blocked' else 3600))
                if outcome in ('updated', 'unchanged', 'available'):
                    state.update(last_checked_at=now, revision=revision)
                if outcome == 'available':
                    state['offered_revision'] = revision
                elif outcome in ('updated', 'unchanged'):
                    state.pop('offered_revision', None)
                state.pop('approved_revision', None)
                state.pop('token', None)
                state.pop('expires_at', None)
                result = {'status': 'recorded', 'next_check_at': state['next_check_at']}
        elif action in ('disable', 'enable'):
            state['disabled'] = action == 'disable'
            if action == 'disable':
                state.pop('token', None)
                state.pop('expires_at', None)
            else:
                state['next_check_at'] = 0
            result = {'status': action + 'd'}
        else:
            raise ValueError('Unknown action')
        con.execute('INSERT OR REPLACE INTO checks VALUES (?,?)', (identity, json.dumps(state)))
        con.execute('COMMIT')
        return result
    finally:
        con.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['claim', 'renew', 'finish', 'disable', 'enable'])
    parser.add_argument('--skill-dir', required=True)
    parser.add_argument('--token')
    parser.add_argument('--outcome', choices=['unchanged', 'updated', 'available', 'blocked', 'error'])
    parser.add_argument('--revision')
    parser.add_argument('--approved-revision', help='Resume a previously offered revision only after explicit user approval.')
    args = parser.parse_args()
    root = Path(args.skill_dir).expanduser().resolve(strict=True)
    manifest = json.loads((root / 'skill-update.json').read_text())
    identity = hashlib.sha256((str(root) + '\n' + manifest['repository'] + '\n' + manifest['path']).encode()).hexdigest()
    base = Path(os.environ.get('XDG_STATE_HOME') or Path.home() / '.local' / 'state')
    try:
        print(json.dumps(operate(base / 'agent-skill-updates' / 'state.sqlite3', identity, args.action,
                                 args.token, args.outcome, args.revision, approved_revision=args.approved_revision)))
    except (ValueError, sqlite3.Error) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
