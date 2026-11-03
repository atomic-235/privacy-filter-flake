{
  lib,
  python3Packages,
  opf,
}:

python3Packages.buildPythonApplication {
  pname = "privacy-filter-server";
  version = "0.1.0";

  pyproject = true;
  src = ./server;

  build-system = [ python3Packages.setuptools ];

  # The wrapper generated for the console script puts opf and its transitive
  # dependencies (torch, tiktoken, ...) on PYTHONPATH.
  dependencies = [ opf ];

  doCheck = false;

  meta = with lib; {
    description = "HTTP redaction service for OpenAI Privacy Filter";
    homepage = "https://github.com/atomic-235/privacy-filter-flake";
    license = licenses.asl20;
    platforms = platforms.linux;
    mainProgram = "privacy-filter-server";
  };
}
