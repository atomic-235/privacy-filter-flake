{
  lib,
  buildNpmPackage,
  makeWrapper,
  nodejs,
}:

let
  data = builtins.fromJSON (builtins.readFile ./version.json);
in
buildNpmPackage {
  pname = "privacy-filter-server";
  version = "0.2.0";

  src = ./server;

  npmDepsHash = "sha256-LIhj6+piMFv8dy/B9kHwJ76LK5sZ2VyviVDQs+pGxQU=";
  npmFlags = [ "--ignore-scripts" ];
  dontNpmBuild = true;
  npmRebuild = false;

  nativeBuildInputs = [ makeWrapper ];

  postPatch = ''
    substituteInPlace server.mjs \
      --replace-fail "@modelRepo@" "${data.model.repo}" \
      --replace-fail "@modelRevision@" "${data.model.revision}"
  '';

  postInstall = ''
    chmod +x $out/bin/privacy-filter-server
    wrapProgram $out/bin/privacy-filter-server \
      --prefix PATH : ${lib.makeBinPath [ nodejs ]}
  '';

  meta = with lib; {
    description = "HTTP redaction service for OpenAI Privacy Filter (ONNX q4)";
    homepage = "https://github.com/atomic-235/privacy-filter-flake";
    license = licenses.asl20;
    platforms = platforms.linux;
    mainProgram = "privacy-filter-server";
  };
}
