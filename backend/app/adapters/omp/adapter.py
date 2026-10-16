"""OmpAdapter: o oh-my-pi e um fork do Pi com o mesmo JSONL e a mesma API de extensao.

Subclasse, nao copia: parser, layout e entrega vem do Pi. O que difere e binario, raiz de
sessoes e o par spawn/resume — o omp nao tem `--session-id`, entao o app escolhe o CAMINHO do
transcript (`-r`) e exporta CP_PI_SESSION pro fallback do bilhete. A sessão nova abre no Rust.
"""
from app.adapters.pi.adapter import PiAdapter


class OmpAdapter(PiAdapter):
    provider = "omp"

    def spawn_command(self, *args, **kwargs) -> list[str]:
        # Sessão nova abre no Rust; o `pi --session-id` herdado subiria o agente errado.
        raise NotImplementedError("sessão nova do omp abre no Rust")
