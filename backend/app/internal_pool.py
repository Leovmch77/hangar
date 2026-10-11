import asyncio
import contextvars
from concurrent.futures import ThreadPoolExecutor
from functools import partial


# O trabalho das rotas `/internal/*` que não espera o Rust roda aqui, fora do pool padrão: lá ficam
# as threads que esperam o próprio Rust, e o pedido dele ficaria esperando por elas. Pelo mesmo
# motivo, nada que roda aqui pode esperar um pedido do Rust que volte ao Python.
executor = ThreadPoolExecutor(max_workers=16, thread_name_prefix="hangar-internal")


async def internal_thread(fn, *args, **kwargs):
    return await asyncio.get_running_loop().run_in_executor(
        executor, contextvars.copy_context().run, partial(fn, *args, **kwargs))
