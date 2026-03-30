Pod::Spec.new do |s|
  s.name             = 'VocalLabsAudioEffects'
  s.version          = '1.1.0'
  s.summary          = 'Vocal Labs Audio Effects for React Native (iOS)'
  s.description      = <<-DESC
    Native iOS audio effects module for Vocal Labs SDK, bridging to React Native.
  DESC
  s.homepage         = 'https://github.com/Vocallabsai/vocal-sdk'
  s.license          = { :type => 'MIT', :file => '../LICENSE' }
  s.author           = { 'Ayushman Lakshkar' => 'ayushmanlakshkar@gmail.com' }
  s.source           = { :git => 'https://github.com/Vocallabsai/vocal-sdk.git', :tag => s.version.to_s }
  s.platform         = :ios, '12.0'
  s.source_files     = 'VocalLabsAudioEffects/*.{h,m,swift}'
  s.requires_arc     = true
  s.dependency       'React-Core'
end
