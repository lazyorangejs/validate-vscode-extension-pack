FROM gitpod/workspace-full

RUN sudo apt-get install zsh -yq \
    && sh -c "$(curl -fsSL https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" \
    && npm i -g ovsx vsce@1.83.0
