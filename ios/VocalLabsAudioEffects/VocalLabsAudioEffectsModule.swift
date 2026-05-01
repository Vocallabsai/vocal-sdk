import AVFoundation
import Foundation
import React

@objc(VocalLabsAudioEffectsModule)
class VocalLabsAudioEffectsModule: RCTEventEmitter {
  private var audioEngine: AVAudioEngine?
  private var inputNode: AVAudioInputNode?
  private var outputNode: AVAudioOutputNode?
  private var gainNode: AVAudioUnitEQ?
  private var isRecording: Bool = false
  private var bufferTapInstalled: Bool = false
  private var hasListeners: Bool = false

  override init() {
    super.init()
  }

  @objc override static func requiresMainQueueSetup() -> Bool {
    return false
  }

  @objc override static func moduleName() -> String! {
    return "VocalLabsAudioEffectsModule"
  }

  override func supportedEvents() -> [String]! {
    return ["onNativeAudioChunk"]
  }

  override func startObserving() {
    hasListeners = true
  }

  override func stopObserving() {
    hasListeners = false
  }

  override func invalidate() {
    if let audioEngine = audioEngine, audioEngine.isRunning {
      inputNode?.removeTap(onBus: 0)
      bufferTapInstalled = false
      audioEngine.stop()
      isRecording = false
    }
    super.invalidate()
  }

  @objc
  func initialize(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    audioEngine = AVAudioEngine()
    inputNode = audioEngine?.inputNode
    outputNode = audioEngine?.outputNode
    gainNode = AVAudioUnitEQ(numberOfBands: 1)
    if let gainNode = gainNode {
      gainNode.globalGain = 0.0
      audioEngine?.attach(gainNode)
      if let inputNode = inputNode, let outputNode = outputNode {
        audioEngine?.connect(inputNode, to: gainNode, format: inputNode.inputFormat(forBus: 0))
        audioEngine?.connect(gainNode, to: outputNode, format: inputNode.inputFormat(forBus: 0))
      }
    }
    resolve(["success": true])
  }

  @objc
  func startNativeRecording(_ options: NSDictionary?, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let audioEngine = audioEngine, let inputNode = inputNode else {
      reject("NO_ENGINE", "Audio engine not initialized", nil)
      return
    }
    if !audioEngine.isRunning {
      let format = inputNode.inputFormat(forBus: 0)
      if !bufferTapInstalled {
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] (buffer, time) in
          self?.processAudioBuffer(buffer: buffer, format: format)
        }
        bufferTapInstalled = true
      }
      do {
        try AVAudioSession.sharedInstance().setCategory(
          .playAndRecord,
          mode: .default,
          options: [.defaultToSpeaker, .allowBluetoothHFP]
        )
        try AVAudioSession.sharedInstance().setActive(true)
        try audioEngine.start()
        isRecording = true
        resolve(["success": true])
      } catch {
        reject("START_ERROR", "Failed to start audio engine: \(error.localizedDescription)", error)
      }
    } else {
      resolve(["success": true])
    }
  }

  @objc
  func stopNativeRecording(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    if let audioEngine = audioEngine, audioEngine.isRunning {
      inputNode?.removeTap(onBus: 0)
      bufferTapInstalled = false
      audioEngine.stop()
      isRecording = false
      resolve(["success": true])
    } else {
      resolve(["success": false])
    }
  }

  @objc
  func setSpeakerphone(_ enabled: Bool, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    do {
      let port: AVAudioSession.PortOverride = enabled ? .speaker : .none
      try AVAudioSession.sharedInstance().overrideOutputAudioPort(port)
      resolve(["success": true])
    } catch {
      reject("SPEAKER_ERROR", "Failed to set speakerphone: \(error.localizedDescription)", error)
    }
  }

  /// Enables iOS hardware Voice Processing I/O (AEC, NS, AGC) on the shared
  /// AVAudioEngine that `react-native-audio-api` uses internally for recording.
  ///
  /// We access the audio-api's `AudioEngine` singleton via Objective-C runtime
  /// — that way we don't need to fork or patch react-native-audio-api itself.
  /// Without VPIO, speakerphone output leaks into the mic and the remote side
  /// hears an echo of their own voice.
  ///
  /// Call this AFTER configuring the audio session as PlayAndRecord/voiceChat
  /// and BEFORE the recorder attaches its sink node (i.e. before
  /// AudioRecorder.onAudioReady on the JS side).
  @objc
  func enableVoiceProcessing(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard #available(iOS 13.0, *) else {
      resolve(["success": false, "reason": "iOS 13+ required"])
      return
    }

    // Look up react-native-audio-api's AudioEngine class at runtime.
    guard let audioEngineClass = NSClassFromString("AudioEngine") as? NSObject.Type else {
      resolve(["success": false, "reason": "AudioEngine class not found"])
      return
    }

    // Call +sharedInstance via dynamic dispatch.
    let sharedSelector = NSSelectorFromString("sharedInstance")
    guard audioEngineClass.responds(to: sharedSelector),
          let sharedInstance = audioEngineClass.perform(sharedSelector)?.takeUnretainedValue() as? NSObject else {
      resolve(["success": false, "reason": "sharedInstance unavailable"])
      return
    }

    // Pull the underlying AVAudioEngine from the wrapper via KVC.
    guard let engine = sharedInstance.value(forKey: "audioEngine") as? AVAudioEngine else {
      resolve(["success": false, "reason": "audioEngine property missing"])
      return
    }

    // VPIO requires PlayAndRecord — bail out gracefully if session isn't set up.
    let session = AVAudioSession.sharedInstance()
    guard session.category == .playAndRecord else {
      resolve(["success": false, "reason": "session category is \(session.category.rawValue), expected playAndRecord"])
      return
    }

    do {
      try engine.inputNode.setVoiceProcessingEnabled(true)
      NSLog("[VocalLabs] ✅ Voice processing (AEC/NS/AGC) enabled on shared input node")
      resolve(["success": true])
    } catch {
      NSLog("[VocalLabs] ❌ Failed to enable voice processing: \(error.localizedDescription)")
      resolve(["success": false, "reason": error.localizedDescription])
    }
  }

  private func processAudioBuffer(buffer: AVAudioPCMBuffer, format: AVAudioFormat) {
    guard hasListeners else { return }
    guard let channelData = buffer.int16ChannelData else { return }
    let channelCount = Int(format.channelCount)
    let frameLength = Int(buffer.frameLength)
    let bytesPerSample = MemoryLayout<Int16>.size
    let byteLength = frameLength * channelCount * bytesPerSample
    let data = Data(bytes: channelData[0], count: byteLength)
    let base64 = data.base64EncodedString()
    let event: [String: Any] = [
      "base64": base64,
      "sampleRate": format.sampleRate,
      "channelCount": channelCount,
      "bytesPerSample": bytesPerSample,
      "byteLength": byteLength
    ]
    sendEvent(withName: "onNativeAudioChunk", body: event)
  }

  @objc
  func startEffect(_ effectName: NSString, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let audioEngine = audioEngine else {
      reject("NO_ENGINE", "Audio engine not initialized", nil)
      return
    }
    if !audioEngine.isRunning {
      do {
        try audioEngine.start()
        isRecording = true
        resolve(["success": true])
      } catch {
        reject("START_ERROR", "Failed to start audio engine: \(error.localizedDescription)", error)
      }
    } else {
      resolve(["success": true])
    }
  }

  @objc
  func stopEffect(_ resolver: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    if let audioEngine = audioEngine, audioEngine.isRunning {
      audioEngine.stop()
      isRecording = false
      resolver(["success": true])
    } else {
      resolver(["success": false])
    }
  }

  @objc
  func setGain(_ gain: NSNumber, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    if let gainNode = gainNode {
      gainNode.globalGain = gain.floatValue
      resolve(["success": true, "gain": gain.floatValue])
    } else {
      reject("NO_GAIN_NODE", "Gain node not initialized", nil)
    }
  }

  @objc
  func isNativeRecording(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(isRecording)
  }
}
