import asyncio
import contextvars
from concurrent.futures import ThreadPoolExecutor
from functools import partial


# A decoração das listas não pode ocupar os workers que entregam mensagens.
_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="hangar-send")


def send_thread(fn, *args, **kwargs):
    return asyncio.get_running_loop().run_in_executor(
        _executor, contextvars.copy_context().run, partial(fn, *args, **kwargs))
