import asyncio
import contextvars
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.internal_pool import internal_thread

_marker = contextvars.ContextVar("marker", default="")


@pytest.mark.asyncio
async def test_internal_thread_runs_with_the_default_pool_full():
    asyncio.get_running_loop().set_default_executor(ThreadPoolExecutor(max_workers=1))
    started, release = threading.Event(), threading.Event()
    waiting = asyncio.ensure_future(asyncio.to_thread(lambda: (started.set(), release.wait(5))))
    try:
        for _ in range(500):
            if started.is_set():
                break
            await asyncio.sleep(0.01)
        assert started.is_set()
        _marker.set("pedido")
        name, marker = await asyncio.wait_for(
            internal_thread(lambda: (threading.current_thread().name, _marker.get())), 1)
        assert name.startswith("hangar-internal")
        assert marker == "pedido"
    finally:
        release.set()
        await waiting
