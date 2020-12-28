import fetch from 'node-fetch'
import GitUrlParse from 'git-url-parse'
import { ExtensionNotFound, OpenVsxExtension } from './types/openvsx'

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

const getExtManifest = async (
  url: string
): Promise<{ owner: string; name: string; repoUrl: string }> => {
  const repository: { url: string } = await fetch(url, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  })
    .then(resp => resp.json())
    .then(resp => resp.repository)

  if (!repository.url) {
    throw new Error(
      'repoUrl should be valid url, for instance https://github.com/microsoft/vscode-docker'
    )
  }

  return { ...GitUrlParse(repository.url), repoUrl: repository.url }
}

export const getRepoByVsixManifest = (
  ext: Extension
): Promise<{ owner: string; name: string; repoUrl: string }> => {
  const assetUrl = ext.versions
    .shift()
    ?.files.find(
      itm => itm.assetType === AssetType.MicrosoftVisualStudioCodeManifest
    )?.source

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
    .then(
      (
        ext: OpenVsxExtension | { error: string; unrelatedPublisher: false }
      ) => {
        return 'error' in ext
          ? {
              publisherName: publisherName.toLowerCase(),
              name: name.toLowerCase(),
              notFound: true,
            }
          : ext
      }
    )
    .catch(() => ({
      publisherName: publisherName.toLowerCase(),
      name: name.toLowerCase(),
      notFound: true,
    }))
}

export const getExtInfoFromMicrosoftStore = async (
  extName: string
): Promise<Extension> =>
  fetch(
    'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
    {
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
    }
  )
    .then(resp => resp.json())
    .then(resp => resp?.results?.pop().extensions?.pop())
