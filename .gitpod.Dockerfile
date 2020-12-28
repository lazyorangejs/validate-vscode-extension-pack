FROM gitpod/workspace-full

RUN apt-get install zsh -yq \
    && sh -c "$(curl -fsSL https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
