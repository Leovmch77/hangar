Pod::Spec.new do |s|
  s.name = 'LiveVoiceAudio'
  s.version = '0.1.0'
  s.summary = 'Sessão de áudio para as chamadas do Hangar.'
  s.description = 'Coordena a sessão de áudio do WebRTC sem outro gravador.'
  s.author = 'Hangar'
  s.homepage = 'https://hangar.dev.br'
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'JitsiWebRTC', '~> 155.0.0'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
