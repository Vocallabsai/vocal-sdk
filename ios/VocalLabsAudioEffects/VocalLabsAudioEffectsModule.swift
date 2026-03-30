import React
import AVFoundation
import Foundation

@objc(VocalLabsAudioEffectsModule)
class VocalLabsAudioEffectsModule: RCTEventEmitter {
  private var audioEngine: AVAudioEngine?
  private var inputNode: AVAudioInputNode?
  private var outputNode: AVAudioOutputNode?
  private var gainNode: AVAudioUnitEQ?
  private var isRecording: Bool = false
  private var bufferTapInstalled: Bool = false

  override static func requiresMainQueueSetup() -> Bool {
    return false
  }

  override func supportedEvents() -> [String]! {
    return ["onNativeAudioChunk"]
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

  private func processAudioBuffer(buffer: AVAudioPCMBuffer, format: AVAudioFormat) {
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
