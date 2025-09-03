#!/usr/bin/env node

// List and manage error reports
// Usage: node list_reports.mjs [status]

import fs from 'fs'

async function loadUserErrorReports() {
  try {
    const content = fs.readFileSync('./user_error_reports.json', 'utf-8')
    return JSON.parse(content)
  } catch {
    return []
  }
}

async function listReports(filterStatus = null) {
  const reports = await loadUserErrorReports()
  
  if (reports.length === 0) {
    console.log('📋 No error reports found.')
    return
  }
  
  let filteredReports = reports
  if (filterStatus) {
    filteredReports = reports.filter(r => r.status === filterStatus)
  }
  
  if (filteredReports.length === 0) {
    console.log(`📋 No reports with status '${filterStatus}' found.`)
    return
  }
  
  console.log('📋 Error Reports:')
  console.log('='.repeat(60))
  
  // Group by status
  const grouped = {}
  for (const report of filteredReports) {
    if (!grouped[report.status]) {
      grouped[report.status] = []
    }
    grouped[report.status].push(report)
  }
  
  for (const [status, statusReports] of Object.entries(grouped)) {
    const statusIcon = status === 'pending' ? '⏳' : status === 'processed' ? '✅' : '❓'
    console.log(`\n${statusIcon} ${status.toUpperCase()} (${statusReports.length})`)
    console.log('-'.repeat(40))
    
    for (const report of statusReports.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))) {
      console.log(`🆔 ${report.id.slice(0, 8)}`)
      console.log(`👤 ${report.username}`)
      console.log(`📝 ${report.description}`)
      console.log(`📅 ${new Date(report.timestamp).toLocaleString()}`)
      if (report.fixedAt) {
        console.log(`🔧 Fixed: ${new Date(report.fixedAt).toLocaleString()}`)
      }
      console.log('')
    }
  }
  
  // Summary
  const pendingCount = reports.filter(r => r.status === 'pending').length
  const processedCount = reports.filter(r => r.status === 'processed').length
  
  console.log('📊 Summary:')
  console.log(`   Total reports: ${reports.length}`)
  console.log(`   Pending: ${pendingCount}`)
  console.log(`   Processed: ${processedCount}`)
  
  if (pendingCount > 0) {
    console.log(`\n⏰ Next automation cycle will process ${pendingCount} pending report(s)`)
  }
}

// Parse command line arguments
const args = process.argv.slice(2)
const filterStatus = args[0] // 'pending', 'processed', or null for all

listReports(filterStatus).catch(console.error)