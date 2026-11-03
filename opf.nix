{
  lib,
  python3Packages,
  fetchFromGitHub,
}:

let
  data = builtins.fromJSON (builtins.readFile ./version.json);
  short = builtins.substring 0 7 data.opfRev;
in
python3Packages.buildPythonApplication {
  pname = "opf";
  version = "0.1.0-unstable-${short}";

  pyproject = true;

  src = fetchFromGitHub {
    owner = "openai";
    repo = "privacy-filter";
    rev = data.opfRev;
    hash = data.opfHash;
  };

  build-system = [ python3Packages.setuptools ];

  dependencies = with python3Packages; [
    huggingface-hub
    numpy
    packaging
    safetensors
    tiktoken
    torch
  ];

  # Upstream tests need checkpoints and network access.
  doCheck = false;

  meta = with lib; {
    description = "Local OpenAI Privacy Filter inference (opf)";
    homepage = "https://github.com/openai/privacy-filter";
    license = licenses.asl20;
    platforms = platforms.linux;
    mainProgram = "opf";
  };
}
