{ pkgs, ... }:

{
  # The Worker (UI, schedule, controller) and its tests.
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    directory = "worker";
    npm.enable = true;
    npm.install.enable = true;
  };

  # scripts/tuya-login.py and its tests. The venv is built from the same requirements file the scripts document.
  languages.python = {
    enable = true;
    venv.enable = true;
    venv.requirements = ./scripts/requirements.txt;
  };

  packages = with pkgs; [
    terraform # infra/ (needs allow_unfree in devenv.yaml)
    gh # scripts/github-setup.mjs
    gnumake # infra/Makefile
    git
  ];

  enterTest = ''
    (cd worker && npm run typecheck && npm test)
    python -m unittest discover -s scripts/tests
    node --check scripts/arch.mjs
    node --check scripts/camera-pusher.mjs
    terraform version
  '';
}
