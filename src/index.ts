import { Octokit } from '@octokit/rest'
import get from 'lodash.get'
import { isValid, decode } from 'js-base64'
import fs, { existsSync, readJSONSync } from 'fs-extra'
import { resolve } from 'path'
import sortBy from 'lodash.sortby'

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
  auth: 'd7a4a5dfeb47908a04dd401f6a1c1fc7322e1881',
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

const addLinks = (
  items: ReadonlyArray<string>
): ReadonlyArray<ExtWithLinks & {
  lastUpdated: string
  licenceUrl: null | string
}> => {
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
    return (pkg.extensionPack as string[]).map(itm => itm.toLowerCase())
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
 * It check that all extensions are added to extension pack from Official VS Code marketplace are presented in OpenVSX store.
 *
 * @example vymarkov.nodejs-devops-extension-pack
 * @see https://marketplace.visualstudio.com/items?itemName=vymarkov.nodejs-devops-extension-pack
 * @see https://open-vsx.org
 *
 * @param {string} extensionPackName
 */
const checkExtensionsInOpenVsxFromVSCodeMarketplace = async (
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

// @ts-ignore
const main = async (extensionPackName: string) => {
  // await octokit.auth({ auth: 'd7a4a5dfeb47908a04dd401f6a1c1fc7322e1881' })

  const filepath = resolve(process.cwd(), '.tmp', 'extensions.json')
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
  const resp = await checkExtensionsInOpenVsxFromVSCodeMarketplace(
    openVsxExtensionList,
    extensionPackName
  )

  await Promise.allSettled(
    resp.notfound.map(async item => {
      const info: Extension = await getExtInfoFromMicrosoftStore(item.name)
      const repo = await getRepoByVsixManifest(info)
      item.repoUrl = repo.repoUrl
      item.lastUpdated = info.lastUpdated
      const { spdx_id, html_url } = await getLicenceSpdxIdByRepoName(
        repo.owner,
        repo.name
      )
      item.licenceUrl = html_url!
      item.licence = spdx_id!
    })
  )
  //
  const notfound = sortBy([...resp.notfound], itm => new Date(itm.lastUpdated))
  const withLicence = notfound.filter(itm => ids.includes(itm.licence))
  const withoutLicence = notfound.filter(itm => !ids.includes(itm.licence))
  console.log('with licence', withLicence, withLicence.length)
  console.log('without licence', withoutLicence, withoutLicence.length)
}

// @ts-ignore
const main1 = async () => {
  const info: Extension = await getExtInfoFromMicrosoftStore(
    'wmaurer.change-case'
  )
  console.log(info.versions[0].files)

  const repo = await getRepoByVsixManifest(info)
  console.log(repo)
}

main('vymarkov.nodejs-devops-extension-pack')
  .then(resp => console.log(resp))
  .catch(err => console.error(err))
