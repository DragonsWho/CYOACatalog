{
  description = "dev env";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        pocketbase = pkgs.python3Packages.buildPythonPackage {
          pname = "pocketbase";
          version = "0.12.1";
          src = pkgs.fetchPypi {
            pname = "pocketbase";
            version = "0.12.1";
            sha256 = "74c64ae894802419b372f6137342d4739383cb027085059b812988cb1d0b78d8";
          };
          doCheck = false;
          pyproject = true;
          pythonRelaxDeps = [ "httpx" ];
          buildInputs = [ pkgs.python3Packages.poetry-core ];
          dependencies = [ pkgs.python3Packages.httpx ];
        };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            (python3.withPackages (ps: with ps; [
              pocketbase
              bcrypt
              requests
              pillow
              xxhash
            ]))
          ];
          shellHook = ''
            export GIT_AUTHOR_EMAIL='sgvsbg8gv29ybgqk@gmail.com'
            export GIT_AUTHOR_NAME='sgvsbg8gv29ybgqk'
            export GIT_COMMITTER_EMAIL='sgvsbg8gv29ybgqk@gmail.com'
            export GIT_COMMITTER_NAME='sgvsbg8gv29ybgqk'
          '';
        };
      });
}
