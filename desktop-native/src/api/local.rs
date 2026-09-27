//! O servidor conectado roda nesta máquina? Só o endereço de loopback conta; IP de rede da própria máquina fica como remoto
//! (na dúvida, remoto: ler o disco local de uma sessão de outra máquina mostraria outro repositório).
use super::Api;

impl Api {
    pub fn is_loopback(&self) -> bool {
        match self.base.host() {
            Some(url::Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        }
    }
}
