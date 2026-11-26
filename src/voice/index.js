// @xocialize/vrmxa-core/voice — voices and their reference clips (VRMXA §9).
export { audioInfo, decodeWav, encodeWav16, mixDown, standardClip, clipWarnings, WavError } from './wav.js';
export {
  emptyVoices, voicesOf, newVoiceMeta, consentProblem, voiceProblems, addVoice, updateVoice, addClip, removeClip, setPrimaryClip,
  setDefaultVoice, removeVoice, voiceSummaries, madeWithProblems, madeWithLicence, ORIGINS, STYLES, VoiceError,
} from './voices.js';
