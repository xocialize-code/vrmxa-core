// A copy of VRMXA_Specification/assets/spec/bases.json (format vrmxa-bases, version 1), taken 2026-11-16.
// Every published Spec, current and retired, by SHA-256 (VRMXA §5.1). test/bases.test.mjs checks
// this copy against the specification's file when that repository is present. Update both together.
export default {
  "format": "vrmxa-bases",
  "version": 1,
  "bases": [
    {
      "name": "Spec",
      "species": "human",
      "status": "standard",
      "adopted": "2026-11-16",
      "file": "spec.vrm",
      "size": 11395860,
      "sha256": "81dadc422ad70bd4cd72f724258afad70f35685ca5c3c7162c7d432bc424c253",
      "vrm": "1.0",
      "generator": "VRoid Studio-2.13.0, with eye meshes from a VRoid Studio-2.16.0 export",
      "measurements": "spec.measurements.json",
      "licence": "https://vrm.dev/licenses/1.0/",
      "note": "The second Spec with full eye meshes: iris, highlight, brow and eyeline no longer cut down to their own art, an eyelash mesh added, and the eye-joy blend shape working. Body, skeleton, materials and measurements unchanged."
    },
    {
      "name": "Spec",
      "species": "human",
      "status": "retired",
      "adopted": "2026-11-13",
      "file": null,
      "size": 10346024,
      "sha256": "d8c29d442cfe8f3fadf3e4f51ff494a4c81ecae6bd836bbb60523f19f3eb4519",
      "vrm": "1.0",
      "generator": "VRoid Studio-2.13.0",
      "measurements": null,
      "licence": "https://vrm.dev/licenses/1.0/",
      "note": "The second Spec: gender-neutral, the first Spec with its shape modified. Replaced on 2026-11-16 by the same model with full eye meshes; its body is identical to the present Spec's. Its file is in this repository's history."
    },
    {
      "name": "Spec",
      "species": "human",
      "status": "retired",
      "file": null,
      "size": 10342428,
      "sha256": "d4c282b2afd8c3340228f56912012d888d51164d728a9d5587ea3b0d74919e6f",
      "vrm": "1.0",
      "generator": "VRoid Studio-2.13.0",
      "measurements": null,
      "licence": "https://vrm.dev/licenses/1.0/",
      "note": "The first Spec: a VRoid female figure. Provisional from the start, replaced on 2026-11-13. Its file is in this repository's history."
    }
  ]
};
