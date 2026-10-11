import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.internal_pool import internal_thread


@pytest.mark.asyncio
async def test_internal_thread_runs_with_the_default_pool_full():
    asyncio.get_running_loop().set_default_executor(ThreadPoolExecutor(max_workers=1))
    release = threading.Event()
    waiting = asyncio.ensure_future(asyncio.to_thread(release.wait, 5))
    try:
        assert await asyncio.wait_for(internal_thread(lambda: "ok"), 1) == "ok"
    finally:
        release.set()
        await waiting
