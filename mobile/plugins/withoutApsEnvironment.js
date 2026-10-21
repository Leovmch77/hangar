const { withEntitlementsPlist } = require('expo/config-plugins');

// O expo-notifications pede push no iOS, mas o IPA é reassinado pelo SideStore com Apple ID
// gratuito, que não tem essa capacidade; push aqui é só Android.
// Fica ANTES do expo-notifications no app.json: o mod registrado por último roda primeiro.
module.exports = (config) => withEntitlementsPlist(config, (cfg) => {
  delete cfg.modResults['aps-environment'];
  return cfg;
});
