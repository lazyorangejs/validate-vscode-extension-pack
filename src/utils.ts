import fetch from 'node-fetch'
import GitUrlParse from 'git-url-parse'
import { ExtensionNotFound, OpenVsxExtension, VSExtension } from './types/openvsx'
import { isValid, decode } from 'js-base64'
import get from 'lodash.get'
import { Octokit } from '@octokit/rest'
import fs, { existsSync, readJSONSync } from 'fs-extra'
import { resolve } from 'path'
import sortBy from 'lodash.sortby'
// @ts-ignore
import * as ids from 'spdx-license-ids'

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
})

export interface ExtensionQuery {
  results: Result[]
}

export interface Result {
  extensions: Extension[]
  pagingToken: null
  resultMetadata: ResultMetadatum[]
}

export interface Extension {
  publisher: Publisher
  extensionId: string
  extensionName: string
  displayName: string
  flags: string
  lastUpdated: string
  publishedDate: string
  releaseDate: string
  shortDescription: string
  versions: Version[]
  categories: string[]
  tags: string[]
  installationTargets: InstallationTarget[]
  deploymentType: number
}

export interface InstallationTarget {
  target: string
  targetVersion: string
}

export interface Publisher {
  publisherId: string
  publisherName: string
  displayName: string
  flags: string
}

export interface Version {
  version: string
  flags: Flags
  lastUpdated: string
  files: File[]
  assetUri: string
  fallbackAssetUri: string
}

export interface File {
  assetType: AssetType
  source: string
}

export enum AssetType {
  MicrosoftVisualStudioCodeManifest = 'Microsoft.VisualStudio.Code.Manifest',
  MicrosoftVisualStudioServicesContentChangelog = 'Microsoft.VisualStudio.Services.Content.Changelog',
  MicrosoftVisualStudioServicesContentDetails = 'Microsoft.VisualStudio.Services.Content.Details',
  MicrosoftVisualStudioServicesContentLicense = 'Microsoft.VisualStudio.Services.Content.License',
  MicrosoftVisualStudioServicesIconsDefault = 'Microsoft.VisualStudio.Services.Icons.Default',
  MicrosoftVisualStudioServicesIconsSmall = 'Microsoft.VisualStudio.Services.Icons.Small',
  MicrosoftVisualStudioServicesVSIXPackage = 'Microsoft.VisualStudio.Services.VSIXPackage',
  MicrosoftVisualStudioServicesVsixManifest = 'Microsoft.VisualStudio.Services.VsixManifest',
}

export enum Flags {
  Validated = 'validated',
}

export interface ResultMetadatum {
  metadataType: string
  metadataItems: MetadataItem[]
}

export interface MetadataItem {
  name: string
  count: number
}

export type PackageJson = {
  extensionPack: ReadonlyArray<string>
  extensionDependencies: ReadonlyArray<string>
}

export const deprecatedExtensionsMap = new Map([
  ['peterjausovec.vscode-docker', 'ms-azuretools.vscode-docker'],
])

const getExtManifest = async (
  url: string
): Promise<{ owner: string; name: string; repoUrl: string }> => {
  const repository: { url: string } | string = await fetch(url, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  })
    .then(resp => resp.json())
    // .then(resp => { console.log(resp); return resp })
    .then(resp => resp.repository)

  if (typeof repository === 'string') {
    return { ...GitUrlParse(repository), repoUrl: repository }
  }

  if (typeof repository === 'object' && !repository.url) {
    throw new Error(
      'repoUrl should be valid url, for instance https://github.com/microsoft/vscode-docker'
    )
  }

  const parsedGitUrl = GitUrlParse(repository.url)
  parsedGitUrl.git_suffix = false

  return { ...parsedGitUrl, repoUrl: parsedGitUrl.toString('https') }
}

export const getRepoByVsixManifest = (
  ext: Extension
): Promise<{ owner: string; name: string; repoUrl: string }> => {
  if (!ext) {
    throw new Error('Extension should not be empty')
  }
  const assetUrl = ext.versions
    .shift()
    ?.files.find(itm => itm.assetType === AssetType.MicrosoftVisualStudioCodeManifest)?.source

  if (!assetUrl) {
    throw new Error('assetUrl should be valid url to ext manifest')
  }

  return getExtManifest(assetUrl)
}

export const findExtByNameInOpenVSX = async (
  publisherName: string,
  name: string
): Promise<OpenVsxExtension | ExtensionNotFound> => {
  return fetch(`https://open-vsx.org/api/${publisherName}/${name}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  })
    .then(res => res.json())
    .then((ext: OpenVsxExtension | { error: string; unrelatedPublisher: false }) => {
      return 'error' in ext
        ? {
            publisherName: publisherName.toLowerCase(),
            name: name.toLowerCase(),
            notFound: true,
          }
        : ext
    })
    .catch(() => ({
      publisherName: publisherName.toLowerCase(),
      name: name.toLowerCase(),
      notFound: true,
    }))
}

export const extractExtensionPackFromPackageJson = (pkg: PackageJson): ReadonlyArray<string> => {
  // https://code.visualstudio.com/api/references/extension-manifest#fields
  return (pkg.extensionPack || pkg.extensionDependencies || []).map(itm => itm.toLowerCase())
}

export const downloadPackageJsonFromGithub = async (
  owner: string,
  repo: string
): Promise<PackageJson> => {
  const resp = await octokit.repos.getContent({
    owner,
    repo,
    path: 'package.json',
  })
  const content = get(resp.data, 'content')
  if (content && isValid(content)) {
    const pkg = JSON.parse(decode(content))
    return pkg
  }
  return { extensionPack: [], extensionDependencies: [] }
}

export const isExtensionPack = async (name: string) => {
  const ext = await getExtInfoFromMicrosoftStore(name)
  if (!ext) {
    throw new Error(`Extension (${name}) not found`)
  }
  const repo = await getRepoByVsixManifest(ext)
  const pkg = await downloadPackageJsonFromGithub(repo.owner, repo.name)
  return extractExtensionPackFromPackageJson(pkg).length > 0
}

export const getExtInfoFromMicrosoftStore = async (extName: string): Promise<Extension> =>
  fetch('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
    method: 'POST',
    headers: {
      Authority: 'marketplace.visualstudio.com',
      Accept: 'application/json;api-version=6.1-preview.1;excludeUrls=true',
      'X-Vss-Reauthenticationaction': 'Suppress',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Tfs-Session': 'f9c6bb9c-8611-4b61-bf08-daa1f06fa2c6',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.183 Safari/537.36 OPR/72.0.3815.320',
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip',
    },
    body: JSON.stringify({
      assetTypes: null,
      filters: [
        {
          criteria: [
            {
              filterType: 7,
              value: extName,
            },
          ],
          direction: 2,
          pageSize: 100,
          pageNumber: 1,
          sortBy: 0,
          sortOrder: 0,
          pagingToken: null,
        },
      ],
      flags: 103,
    }),
  })
    .then(async resp => {
      return resp.json()
    })
    .then(resp => resp?.results?.pop().extensions?.pop())

/**
 * Some of extensions are not open source thus can not built and published to Open VSX from https://github.com/open-vsx/publish-extensions
 *
 * @see https://github.com/open-vsx/publish-extensions
 */
const extensionsDontMeetOpenVSXConditons = [
  'wallabyjs.quokka-vscode',
  'visualstudioexptteam.vscodeintellicode',
]

const getGithubRepoInfo = async (owner: string, repo: string) => {
  const info = await octokit.repos.get({
    owner,
    repo,
  })

  return info?.data
}

const getlicenseSpdxIdByRepoName = async (
  owner: string,
  repo: string
): Promise<{ html_url: string | undefined; spdx_id?: string | null }> => {
  const info = await getGithubRepoInfo(owner, repo)
  const { spdx_id, html_url } = info.license!
  return { spdx_id, html_url }
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

const addLinks = (items: ReadonlyArray<string>): ReadonlyArray<VSExtension> => {
  return items.map(name => {
    const [publisherName, extname] = name.split('.')

    return {
      name,
      msmarketplaceUrl: 'https://marketplace.visualstudio.com/items?itemName=' + name,
      openvsx: `https://open-vsx.org/extension/${publisherName}/${extname}`,
      repoUrl: null,
      license: null,
      licenseUrl: null,
      lastUpdated: '',
    }
  })
}

const extName = (publisherName: string, name: string) => {
  return `${publisherName}.${name}`.toLowerCase()
}

export const ensureExtensionsFileAndReturnMap = async (
  filepath: string = resolve(process.cwd(), '.tmp', 'extensions.json')
) => {
  if (!existsSync(filepath)) {
    const body = await downloadOpenVsxExtensionsList()
    fs.outputJSONSync(filepath, body)
  }

  const openVsxExtensionList = new Map<string, { id: string }>(
    readJSONSync(filepath).extensions.map((itm: { id: string }) => [itm.id.toLowerCase(), itm])
  )

  return openVsxExtensionList
}

/**
 * It checks that all extensions which are added to extension pack from Official VS Code marketplace are presented in Open VSX store.
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
  let repo

  try {
    repo = await getRepoByVsixManifest(info)
  } catch (err) {
    throw new Error('Extension pack not found')
  }

  const pkg = await downloadPackageJsonFromGithub(repo.owner, repo.name)
  const list = extractExtensionPackFromPackageJson(pkg)

  const notfound = list.filter(id => !openVsxExtensionMap.has(id))
  notfound.push(extensionPackName)

  const extensionsFromOpenVSX: (OpenVsxExtension | ExtensionNotFound)[] = await Promise.all(
    notfound.map(extID => {
      const [publisherName, extName] = extID.split('.')
      return findExtByNameInOpenVSX(publisherName, extName)
    })
  )

  const extensionsFromOpenVSXMap = new Map<string, { id: string }>(
    (extensionsFromOpenVSX as OpenVsxExtension[])
      .filter(itm => !('notFound' in itm))
      .map(itm => [extName(itm.namespace, itm.name), { id: extName(itm.namespace, itm.name) }])
  )

  return {
    all: list,
    found: addLinks(
      list.filter(id => openVsxExtensionMap.has(id) || extensionsFromOpenVSXMap.has(id))
    ),
    notfound: addLinks(
      list.filter(id => !(openVsxExtensionMap.has(id) || extensionsFromOpenVSXMap.has(id)))
    ),
  }
}

export const getExtensionThatNotPresentOnOpenVSX = async (
  extensionPackName: string,
  openVsxExtensionList: Map<string, { id: string }>
) => {
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
      const { spdx_id, html_url } = await getlicenseSpdxIdByRepoName(repo.owner, repo.name)
      item.licenseUrl = html_url! || null
      item.license = spdx_id!
    })
  )
  //
  const notfound = sortBy([...extensions.notfound], itm => new Date(itm.lastUpdated))
  const deprecatedExtensions = extensions.all.filter(name => deprecatedExtensionsMap.has(name))
  const dontMeetConditions = extensions.all.filter(name =>
    Boolean(extensionsDontMeetOpenVSXConditons.find(itm => itm === name))
  )

  const notFoundWithlicense = notfound.filter(
    itm =>
      ids.includes(itm.license) &&
      !deprecatedExtensions.includes(itm.name) &&
      !dontMeetConditions.includes(itm.name)
  )

  const notFoundWithoutlicense = notfound.filter(
    itm =>
      !ids.includes(itm.license) &&
      !deprecatedExtensions.includes(itm.name) &&
      !dontMeetConditions.includes(itm.name)
  )

  return {
    all: new Map(notfound.map(itm => [itm.name, itm])),
    notFoundWithlicense,
    notFoundWithoutlicense,
    deprecatedExtensions,
    dontMeetConditions,
  }
}
