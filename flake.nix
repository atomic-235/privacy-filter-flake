{
  description = "OpenAI Privacy Filter as a local redaction service (ONNX q4)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          service = pkgs.callPackage ./package.nix { };
        in
        rec {
          default = service;
          privacy-filter = service;
        }
      );

      overlays.default = final: _prev: {
        privacy-filter = final.callPackage ./package.nix { };
      };
    };
}
