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
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            go
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
