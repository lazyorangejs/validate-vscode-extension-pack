import { Octokit } from '@octokit/rest'
import get from 'lodash.get'
import { isValid, decode } from 'js-base64'
import fs, { existsSync, readJSONSync } from 'fs-extra'
import { resolve } from 'path'
import sortBy from 'lodash.sortby'
import * as program from 'commander'

// @ts-ignore
import { fetchExtInfoFromClonedRepo } from 'publish-to-open-vsx/add-extension'
// @ts-ignore
import { addNewExtension, writeToExtensionsFile } from 'publish-to-open-vsx/add-extension'
// @ts-ignore
import { onDidAddExtension, readExtensionsFromFile } from 'publish-to-open-vsx/add-extension'

import {
  downloadPackageJsonFromGithub,
  Extension,
  extractExtensionPackFromPackageJson,
  findExtByNameInOpenVSX,
  getExtInfoFromMicrosoftStore,
  getRepoByVsixManifest,
  isExtensionPack,
} from './utils'
import { OpenVsxExtension } from './types/openvsx'
// @ts-ignore
import * as ids from 'spdx-license-ids'

type ExtensionNotFound = {
  publisherName: string
  name: string
  notFound: boolean
}

const deprecatedExtensionsMap = new Map([
  ['peterjausovec.vscode-docker', 'ms-azuretools.vscode-docker'],
])

/**
 * Some of extenions can not be published to OpenVSX registry,
 * cause the extenion must be open sourced.
 * @see https://github.com/wallabyjs/public/issues/2436#issuecomment-741415194
 */
const extensionsDontMeetOpenVSXConditons = ['wallabyjs.quokka-vscode']

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
      msmarketplace: 'https://marketplace.visualstudio.com/items?itemName=' + name,
      openvsx: `https://open-vsx.org/extension/${publisherName}/${extname}`,
      repoUrl: null,
      licence: null,
      licenceUrl: null,
      lastUpdated: '',
    }
  })
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
  let repo

  try {
    repo = await getRepoByVsixManifest(info)
  } catch (err) {
    throw new Error('Extension pack not found')
  }

  const pkg = await downloadPackageJsonFromGithub(repo.owner, repo.name)
  const list = extractExtensionPackFromPackageJson(pkg)

  const notfound = list.filter(id => !openVsxExtensionMap.has(id))

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

const ensureExtensionsFileAndReturnMap = async (
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

const getExtensionThatNotPresentOnOpenVSX = async (extensionPackName: string) => {
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
      const { spdx_id, html_url } = await getLicenceSpdxIdByRepoName(repo.owner, repo.name)
      item.licenceUrl = html_url! || null
      item.licence = spdx_id!
    })
  )
  //
  const notfound = sortBy([...extensions.notfound], itm => new Date(itm.lastUpdated))
  const deprecatedExtensions = extensions.all.filter(name => deprecatedExtensionsMap.has(name))
  const dontMeetConditions = extensions.all.filter(name =>
    Boolean(extensionsDontMeetOpenVSXConditons.find(itm => itm === name))
  )

  const notFoundWithLicence = notfound.filter(itm => ids.includes(itm.licence))
  const notFoundWithoutLicence = notfound.filter(itm => !ids.includes(itm.licence))

  return {
    notFoundWithLicence,
    notFoundWithoutLicence,
    deprecatedExtensions,
    dontMeetConditions,
  }
}

const getExtensionNamesFromFile = async (extensionsFile: string) => {
  const { extensions }: { extensions: { id: string }[] } = await readExtensionsFromFile(
    extensionsFile
  )
  return (extensions ?? []).map(itm => itm.id)
}

const addExtensions = async (notAddedExtensions: VSExtension[], extensionsFile: string) => {
  if (notAddedExtensions.length === 0) {
    return
  }
  const filepath = resolve(process.cwd(), extensionsFile)
  const { extensions } = await readExtensionsFromFile(filepath)
  const repos = notAddedExtensions.map(itm => itm.repoUrl)

  const extensionsToAdd = []
  for (const repository of repos) {
    const resp = await fetchExtInfoFromClonedRepo(repository, {})
    await addNewExtension(resp.extension, resp.package, extensions)
    extensionsToAdd.push(resp.extension)
  }
  extensionsToAdd.forEach(extension => onDidAddExtension(extension))
  await writeToExtensionsFile(extensions, extensionsFile)
}

// vymarkov.nodejs-devops-extension-pack
// jabacchetta.vscode-essentials
// mubaidr.vuejs-extension-pack
// formulahendry.auto-complete-tag
// afractal.node-essentials

program
  .version('0.0.1')
  .command('add <extension-name> [extensions.json]')
  .description(
    'add extension or extension pack to extension.json to publish to Open VSX, by default command will add extensions only if pack meet all conditions'
  )
  .action(async (name: string, extensionsFile: string, program) => {
    try {
      const extensionsFromFile: string[] = await getExtensionNamesFromFile(extensionsFile)

      if (await isExtensionPack(name)) {
        const {
          notFoundWithLicence,
          notFoundWithoutLicence,
          deprecatedExtensions,
          dontMeetConditions,
        } = await getExtensionThatNotPresentOnOpenVSX(name)

        if (dontMeetConditions.length > 0) {
          console.log(
            'Extension that are not open source can not be published to Open VSX registry due to licence restiction'
          )
          console.log(
            'You can read more at https://github.com/wallabyjs/public/issues/2436#issuecomment-741415194'
          )
          console.log(dontMeetConditions)
        }

        if (deprecatedExtensions.length > 0) {
          console.log(
            'Some of extensions are deprecated, you have to update extension ids in order to publish the extension pack.'
          )
          for (const id of deprecatedExtensions.values()) {
            console.log(
              `You need to update extension id from "${id}" to "${deprecatedExtensionsMap.get(id)}"`
            )
          }
          console.log(' ')
        }

        if (notFoundWithLicence.length > 0) {
          console.log('See below extensions that are not present in Open VSX marketplace:')
          console.log(
            `extensions with licence (${notFoundWithLicence.length}):`,
            notFoundWithLicence
          )
        }

        if (notFoundWithoutLicence.length > 0) {
          console.log(
            `extensions without licence (${notFoundWithoutLicence.length}):`,
            notFoundWithoutLicence
          )
          console.log(
            'Extensions without licence CAN NOT BE uploaded to Open VSX registry, LICENCE must be present'
          )
        }

        const allConditionsAreMet =
          !notFoundWithLicence.length &&
          !notFoundWithoutLicence.length &&
          !deprecatedExtensions.length &&
          !dontMeetConditions.length
        if (allConditionsAreMet) {
          console.log('All extensions are present in Open VSX marketplace.')
        }

        if (allConditionsAreMet || program.addExtensionsWithLicence) {
          console.log(`Adding extensions with defined licence to ${extensionsFile}`)

          const extensionsToAdd = notFoundWithLicence.filter(
            itm => !extensionsFromFile.find(name => itm.name === name)
          )
          await addExtensions(extensionsToAdd, extensionsFile)
        }
      } else {
        console.log('Adding extension by name is not supported!')
      }
    } catch (err) {
      console.log(err.message)
    }
  })
  .option(
    '--add-extensions-with-licence',
    'Add extensions that have licence even if extension pack contains extensions without licence'
  )
  .option('--extension-name <string>', "Extension's name to add")
  .on('--help', () => {
    console.log('Examples:')
    console.log('')
    console.log('  $ -n vymarkov.nodejs-devops-extension-pack')
  })
  .parse(process.argv)
