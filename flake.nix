{
  description = "OpenAI Privacy Filter as a local redaction service";

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
          opf = pkgs.callPackage ./opf.nix { };
          service = pkgs.callPackage ./package.nix { inherit opf; };
        in
        rec {
          default = service;
          inherit opf;
          privacy-filter = service;
        }
      );

      overlays.default = final: _prev: {
        opf = final.callPackage ./opf.nix { };
        privacy-filter = final.callPackage ./package.nix {
          opf = final.callPackage ./opf.nix { };
        };
      };
    };
}
