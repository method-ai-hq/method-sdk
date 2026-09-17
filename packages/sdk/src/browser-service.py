"""Private line protocol for the pinned browser-use direct controls."""
import asyncio
import contextlib
import json
import os
import sys
import signal
import shutil
from pathlib import Path
from urllib.parse import urlparse

os.environ['ANONYMIZED_TELEMETRY'] = 'false'
os.environ['BROWSER_USE_LOGGING_LEVEL'] = 'critical'
os.umask(0o077)
protocol = sys.stdout
sys.stdout = sys.stderr
from browser_use.mcp.server import BrowserUseServer
from browser_use.browser import BrowserProfile, BrowserSession
from browser_use.tools.service import Tools

CATALOG = json.loads((Path(__file__).parent / 'browser-runtime/tools.json').read_text())
ALLOWED = {tool['name'] for tool in CATALOG}

class BrowserDisconnected(Exception):
    pass


def require_browser(session):
    if not session or not session.is_cdp_connected:
        raise BrowserDisconnected('Browser connection lost. Chrome closed or disconnected.')


async def call_browser(server, name, parameters):
    require_browser(server.browser_session)
    try:
        content = await server._execute_tool(name, parameters)
    except Exception as error:
        require_browser(server.browser_session)
        # Provider exception text can contain cookies or private connection URLs.
        return {'isError': True, 'content': [{'type': 'text', 'text':
            type(error).__name__ + ': browser action failed. Inspect the page and try another action.'}]}
    require_browser(server.browser_session)
    return {'content': [v.model_dump(by_alias=True, exclude_none=True) for v in content]
            if isinstance(content, list) else [{'type': 'text', 'text': content}]}


async def serve():
    server = BrowserUseServer()
    domains = set()
    owned = False
    copied_profile = None
    async def close_browser():
        try:
            if server.browser_session:
                await asyncio.wait_for(server.browser_session.kill() if owned else server.browser_session.stop(), 5)
        finally:
            if copied_profile:
                shutil.rmtree(copied_profile, ignore_errors=True)
    async def stop():
        with contextlib.suppress(Exception):
            await close_browser()
        os._exit(0)
    for sig in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(sig, lambda: asyncio.create_task(stop()))
    async def save(path):
        state = await server.browser_session.export_storage_state()
        def selected(host):
            host = host.lstrip('.').lower()
            return any(d == host or d.endswith('.' + host) for d in domains)
        state['cookies'] = [c for c in state.get('cookies', []) if selected(c['domain'])]
        state['origins'] = [o for o in state.get('origins', []) if selected(urlparse(o['origin']).hostname or '')]
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = target.with_suffix('.tmp')
        tmp.write_text(json.dumps(state)); tmp.chmod(0o600); tmp.replace(target)
        return {'domains': sorted(domains)}
    while line := await asyncio.to_thread(sys.stdin.readline):
        request = json.loads(line)
        try:
            method, args = request['method'], request.get('args', {})
            if method == 'start':
                owned = not bool(args.get('cdp_url'))
                domains.update(args.pop('domains', []))
                # Give the library a value, not our export path: its shutdown save
                # must not overwrite the site-filtered transfer file.
                if isinstance(args.get('storage_state'), str):
                    args['storage_state'] = json.loads(Path(args['storage_state']).read_text())
                profile = BrowserProfile(**args, enable_default_extensions=False, args=['--disable-extensions'], keep_alive=not owned)
                if owned and str(profile.user_data_dir) != str(args.get('user_data_dir')) and Path(profile.user_data_dir).name.startswith('browser-use-user-data-dir-'):
                    copied_profile = profile.user_data_dir
                server.browser_session = BrowserSession(browser_profile=profile)
                await server.browser_session.start()
                server.tools = Tools()
                result = {'started': True}
            elif method == 'call':
                name = args['name']
                if name not in ALLOWED:
                    raise ValueError('Unsupported browser control')
                parameters = args.get('arguments', {})
                if name == 'browser_navigate':
                    host = urlparse(parameters['url']).hostname
                    if host: domains.add(host.lower())
                result = await call_browser(server, name, parameters)
                # Followed links and sign-in redirects belong to this task's active tab.
                require_browser(server.browser_session)
                page = await server.browser_session.get_current_page()
                if page and name != 'browser_list_tabs':
                    host = urlparse(await page.get_url()).hostname
                    if host: domains.add(host.lower())
            elif method == 'export':
                result = await save(args['path'])
            elif method == 'close':
                await close_browser()
                result = {'closed': True}
            else:
                raise ValueError('Unknown browser operation')
            protocol.write(json.dumps({'id': request['id'], 'result': result}) + '\n'); protocol.flush()
            if method == 'close': return
        except Exception as error:
            # Avoid exporting exception text that can contain connection URLs or cookies.
            protocol.write(json.dumps({'id': request['id'], 'error': {'code': 'connection_failed', 'message': str(error) if isinstance(error, BrowserDisconnected) else type(error).__name__ + ': browser service failed.'}}) + '\n'); protocol.flush()
    if server.browser_session:
        with contextlib.suppress(Exception):
            await close_browser()

if __name__ == '__main__':
    asyncio.run(serve())
