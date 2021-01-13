#!/usr/bin/env node

import * as program from 'commander'
import { resolve } from 'path'

// @ts-ignore
import { fetchExtInfoFromClonedRepo } from 'publish-to-open-vsx/add-extension'
// @ts-ignore
import { addNewExtension, writeToExtensionsFile } from 'publish-to-open-vsx/add-extension'
// @ts-ignore
import { onDidAddExtension, readExtensionsFromFile } from 'publish-to-open-vsx/add-extension'
import { VSExtension } from './types/openvsx'
import {
  deprecatedExtensionsMap,
  getExtensionThatNotPresentOnOpenVSX,
  isExtensionPack,
} from './utils'

// vymarkov.nodejs-devops-extension-pack
// jabacchetta.vscode-essentials
// mubaidr.vuejs-extension-pack
// formulahendry.auto-complete-tag
// afractal.node-essentials

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

program
  .version('0.0.1')
  .command('add <extension-name> [extensions.json]')
  .description(
    'add extension or extension pack to extension.json to publish to Open VSX, by default command adds extensions if pack meet all conditions only'
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
          const extensionsToAdd = notFoundWithLicence.filter(
            itm => !extensionsFromFile.find(name => itm.name === name)
          )

          if (extensionsToAdd.length > 0) {
            console.log(`Adding extensions with defined licence to ${extensionsFile}`)
            await addExtensions(extensionsToAdd, extensionsFile)
          }
        }
      } else {
        console.log('Adding extension by name is not supported!')
      }
    } catch (err) {
      console.error(err)
      console.error(err.message)
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
