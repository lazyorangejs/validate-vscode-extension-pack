import { Octokit } from '@octokit/rest'
import get from 'lodash.get'
import { isValid, decode } from 'js-base64'
import fs, { existsSync, readJSONSync } from 'fs-extra'
import { resolve } from 'path'
import sortBy from 'lodash.sortby'
import * as program from 'commander'

import {
  Extension,
  findExtByNameInOpenVSX,
  getExtInfoFromMicrosoftStore,
  getRepoByVsixManifest,
} from './utils'
import { OpenVsxExtension } from './types/openvsx'
// @ts-ignore
import * as ids from 'spdx-license-ids'

type ExtensionNotFound = {
  publisherName: string
  name: string
  notFound: boolean
}

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
})

const getGithubRepoInfo = async (owner: string, repo: string) => {
  const info = await octokit.repos.get({
    owner,
    repo,
  })

  return info?.data
}

const getLicenceSpdxIdByRepoName = async (
  owner: string,
  repo: string
): Promise<{ html_url: string | undefined; spdx_id?: string | null }> => {
  const info = await getGithubRepoInfo(owner, repo)
  const { spdx_id, html_url } = info.license!
  return { spdx_id, html_url }
}

type ExtWithLinks = {
  name: string
  msmarketplace: string
  openvsx: string
  repoUrl: string | null
  licence: null | string
}

type VSExtension = ExtWithLinks & {
  lastUpdated: string
  licenceUrl: null | string
}

const addLinks = (items: ReadonlyArray<string>): ReadonlyArray<VSExtension> => {
  return items.map(name => {
    const [publisherName, extname] = name.split('.')

    return {
      name,
      msmarketplace:
        'https://marketplace.visualstudio.com/items?itemName=' + name,
      openvsx: `https://open-vsx.org/extension/${publisherName}/${extname}`,
      repoUrl: null,
      licence: null,
      licenceUrl: null,
      lastUpdated: '',
    }
  })
}

export const downloadVsixExtensionManifestFromGithub = async (
  owner: string,
  repo: string
): Promise<ReadonlyArray<string>> => {
  const resp = await octokit.repos.getContent({
    owner,
    repo,
    path: 'package.json',
  })
  const content = get(resp.data, 'content')
  if (content && isValid(content)) {
    const pkg = JSON.parse(decode(content))
    // https://code.visualstudio.com/api/references/extension-manifest#fields
    const extensionDependencies: string[] =
      pkg.extensionPack || pkg.extensionDependencies
    return extensionDependencies.map(itm => itm.toLowerCase())
  }
  return []
}

export const downloadOpenVsxExtensionsList = async (
  owner = 'open-vsx',
  repo = 'publish-extensions'
) => {
  const resp = await octokit.repos.getContent({
    owner,
    repo,
    path: 'extensions.json',
  })

  if (get(resp.data, 'content') && isValid(get(resp.data, 'content'))) {
    const filebody = JSON.parse(decode(get(resp.data, 'content')))
    return filebody
  }
}

const extName = (publisherName: string, name: string) => {
  return `${publisherName}.${name}`.toLowerCase()
}

/**
 * It check that all extensions which are added to extension pack from Official VS Code marketplace are presented in Open VSX store.
 *
 * @example vymarkov.nodejs-devops-extension-pack
 * @see https://marketplace.visualstudio.com/items?itemName=vymarkov.nodejs-devops-extension-pack
 * @see https://open-vsx.org
 *
 * @param {string} extensionPackName
 */
export const checkExtensionsInOpenVsxFromVSCodeMarketplace = async (
  openVsxExtensionMap: Map<string, { id: string }>,
  extensionPackName: string
) => {
  const info: Extension = await getExtInfoFromMicrosoftStore(extensionPackName)
  const repo = await getRepoByVsixManifest(info)

  const list = await downloadVsixExtensionManifestFromGithub(
    repo.owner,
    repo.name
  )

  const notfound = list.filter(id => !openVsxExtensionMap.has(id))

  const extensionsFromOpenVSX: (
    | OpenVsxExtension
    | ExtensionNotFound
  )[] = await Promise.all(
    notfound.map(extID => {
      const [publisherName, extName] = extID.split('.')
      return findExtByNameInOpenVSX(publisherName, extName)
    })
  )

  const extensionsFromOpenVSXMap = new Map<string, { id: string }>(
    (extensionsFromOpenVSX as OpenVsxExtension[])
      .filter(itm => !('notFound' in itm))
      .map(itm => [
        extName(itm.namespace, itm.name),
        { id: extName(itm.namespace, itm.name) },
      ])
  )

  return {
    all: list,
    found: addLinks(
      list.filter(
        id => openVsxExtensionMap.has(id) || extensionsFromOpenVSXMap.has(id)
      )
    ),
    notfound: addLinks(
      list.filter(
        id => !(openVsxExtensionMap.has(id) || extensionsFromOpenVSXMap.has(id))
      )
    ),
  }
}

const ensureExtensionsFileAndReturnMap = async (
  filepath: string = resolve(process.cwd(), '.tmp', 'extensions.json')
) => {
  if (!existsSync(filepath)) {
    const body = await downloadOpenVsxExtensionsList()
    fs.outputJSONSync(filepath, body)
  }

  const openVsxExtensionList = new Map<string, { id: string }>(
    readJSONSync(filepath).extensions.map((itm: { id: string }) => [
      itm.id.toLowerCase(),
      itm,
    ])
  )

  return openVsxExtensionList
}

const getExtensionThatNotPresentOnOpenVSX = async (
  extensionPackName: string
) => {
  const openVsxExtensionList = await ensureExtensionsFileAndReturnMap()

  const extensions = await checkExtensionsInOpenVsxFromVSCodeMarketplace(
    openVsxExtensionList,
    extensionPackName
  )

  await Promise.allSettled(
    extensions.notfound.map(async item => {
      const info: Extension = await getExtInfoFromMicrosoftStore(item.name)
      const repo = await getRepoByVsixManifest(info)
      item.repoUrl = repo.repoUrl
      item.lastUpdated = info.lastUpdated
      const { spdx_id, html_url } = await getLicenceSpdxIdByRepoName(
        repo.owner,
        repo.name
      )
      item.licenceUrl = html_url! || null
      item.licence = spdx_id!
    })
  )
  //
  const notfound = sortBy(
    [...extensions.notfound],
    itm => new Date(itm.lastUpdated)
  )
  const notFundWithLicence = notfound.filter(itm => ids.includes(itm.licence))
  const notfoundWithoutLicence = notfound.filter(
    itm => !ids.includes(itm.licence)
  )

  return { notFundWithLicence, notfoundWithoutLicence }
}

// const extensionPackName = 'vymarkov.nodejs-devops-extension-pack'
// const extensionPackName = 'burkeholland.vs-code-can-do-that'
// const extensionPackName = 'jabacchetta.vscode-essentials'
// const extensionPackName = 'mubaidr.vuejs-extension-pack'
// const extensionPackName = 'formulahendry.auto-complete-tag'

program
  .version('0.0.1')
  .option(
    '-n, --ext-name <string>',
    "Extension pack's name",
    async (extensionPackName: string) => {
      const {
        notFundWithLicence,
        notfoundWithoutLicence,
      } = await getExtensionThatNotPresentOnOpenVSX(extensionPackName)
      console.log(
        'See below extensions that are not present in Open VSX marketplace:'
      )
      console.log('extensions with licence: ', notFundWithLicence)
      console.log('extensions without licence: ', notfoundWithoutLicence)
      console.log(
        'Extensions without licence CAN NOT BE uploaded to Open VSX registry, LICENCE must be present'
      )
    }
  )
  .on('--help', () => {
    console.log('Examples:')
    console.log('')
    console.log('  $ -n vymarkov.nodejs-devops-extension-pack')
  })
  .parse(process.argv)
